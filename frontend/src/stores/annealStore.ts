/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW, HELD_ANNEAL_STATE, VOID_ANNEAL_STATE, isAnnealOccupying } from '../types/anneal'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
} from '../utils/db'
import {
  checkSlotConflict,
  formatHours,
  kilnSlots,
  segmentHours,
  totalAnnealHours,
  type SlotConflict,
} from '../utils/thermal'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  basisWallThicknessMm: number
  basisDesignHeightMm: number
  lifecycleNote: string
  inAt: string
  outAt: string
  state: AnnealState
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表：只展示有效占位；挂起 / 作废记录保留在记录列表，不进入占用表 */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .filter((row) => isAnnealOccupying(row.state))
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          basisWallThicknessMm: row.basisWallThicknessMm,
          basisDesignHeightMm: row.basisDesignHeightMm,
          lifecycleNote: row.lifecycleNote,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          occupied: row.state !== '已出炉',
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /** 某件作品的窑位冲突检测（编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId' | 'state' | 'basisWallThicknessMm'>,
  ): SlotConflict {
    return checkSlotConflict(anneals.value, candidate, wallThicknessOf, candidate.id)
  }

  /** 会阻止新建排位的同作品记录：待入窑 / 退火中 / 已挂起；历史已出炉与已作废不阻止返工后再排 */
  function existingPlanOf(pieceId: string, excludeAnnealId = ''): Anneal | undefined {
    return anneals.value.find(
      (row) =>
        row.pieceId === pieceId &&
        row.id !== excludeAnnealId &&
        (row.state === HELD_ANNEAL_STATE ||
          (isAnnealOccupying(row.state) && row.state !== '已出炉')),
    )
  }

  /** 已有效占位的同作品记录；已作废 / 已挂起不阻止挂起记录重试成功 */
  function activeAnnealOf(pieceId: string, excludeAnnealId = ''): Anneal | undefined {
    return anneals.value.find(
      (row) =>
        row.pieceId === pieceId &&
        row.id !== excludeAnnealId &&
        isAnnealOccupying(row.state),
    )
  }

  /** 某条退火记录排位时记录的壁厚；作品壁厚可能已在之后调整 */
  function basisThicknessOf(annealId: string): number {
    return anneals.value.find((row) => row.id === annealId)?.basisWallThicknessMm ?? 4
  }

  /** 某条退火记录的理论时长；始终按排位时保存的依据壁厚计算 */
  function durationOfAnneal(annealId: string): { hours: number; text: string } {
    const row = anneals.value.find((item) => item.id === annealId)
    const thickness = row?.basisWallThicknessMm ?? 4
    const hours = segmentHours(row?.curveSeg ?? '缓冷', thickness)
    return { hours, text: formatHours(hours) }
  }

  /** 某件作品的退火时长汇总 */
  function durationOf(pieceId: string): { hours: number; text: string } {
    const thickness = wallThicknessOf(pieceId)
    const hours = totalAnnealHours(thickness)
    return { hours, text: formatHours(hours) }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows] = await Promise.all([db.anneals.toArray(), db.pieces.toArray()])
          return { annealRows, pieceRows }
        }).subscribe({
          next: ({ annealRows, pieceRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const duplicate = existingPlanOf(draft.pieceId)
    if (duplicate !== undefined) {
      lastMessage.value =
        duplicate.state === HELD_ANNEAL_STATE
          ? `该作品已有一条挂起重排，请在挂起记录上重试，不重复生成排位。`
          : `该作品已有有效退火记录（${duplicate.kilnSlot} · ${duplicate.state}），不会重复占位；请重排或编辑既有记录。`
      return null
    }
    const stamp = nowIso()
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
      state: draft.state,
      basisWallThicknessMm: draft.basisWallThicknessMm,
    })
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: conflict.conflict ? HELD_ANNEAL_STATE : draft.state,
      basisWallThicknessMm: draft.basisWallThicknessMm,
      basisDesignHeightMm: draft.basisDesignHeightMm,
      lifecycleNote: conflict.conflict
        ? `重排时间窗撞窑位，已挂起等待人工确认；未占用 ${draft.kilnSlot}。${conflict.message}`
        : '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    if (conflict.conflict) {
      lastMessage.value = `时间窗冲突，已挂起本次重排；既有窑位记录保持不变。${conflict.message}`
    } else {
      lastMessage.value = `已分配窑位 ${row.kilnSlot}，依据壁厚 ${row.basisWallThicknessMm} mm，该段理论时长 ${formatHours(segmentHours(row.curveSeg, row.basisWallThicknessMm))}`
    }
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    if (existing.state === VOID_ANNEAL_STATE) {
      lastMessage.value = '该退火记录已因壁厚变更作废，不能覆盖；请按新壁厚重排。'
      return false
    }

    const candidate = {
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
      state: draft.state,
      basisWallThicknessMm: draft.basisWallThicknessMm,
    }
    const duplicate = activeAnnealOf(draft.pieceId, annealId)
    if (duplicate !== undefined) {
      lastMessage.value = `该作品已有其他有效退火记录（${duplicate.kilnSlot} · ${duplicate.state}），不能重复占位。`
      return false
    }
    const conflict = conflictOf(candidate)
    if (conflict.conflict) {
      if (existing.state !== HELD_ANNEAL_STATE) {
        lastMessage.value = `调整会撞时间窗，已保留原记录不变；可先挂起重排等待人工确认。${conflict.message}`
        return false
      }
      await putAnneal({
        ...existing,
        ...draft,
        state: HELD_ANNEAL_STATE,
        basisWallThicknessMm: draft.basisWallThicknessMm,
        basisDesignHeightMm: draft.basisDesignHeightMm,
        lifecycleNote: `重排时间窗撞窑位，已挂起等待人工确认；未占用 ${draft.kilnSlot}。${conflict.message}`,
      })
      revision.value += 1
      lastMessage.value = '仍与已占时间窗冲突，挂起记录已更新；既有占位记录未改动。'
      return true
    }

    await putAnneal({
      ...existing,
      ...draft,
      basisWallThicknessMm: draft.basisWallThicknessMm,
      basisDesignHeightMm: draft.basisDesignHeightMm,
      lifecycleNote: '',
    })
    revision.value += 1
    lastMessage.value = '退火编排已更新，未改动吹制工序记录'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) {
      lastMessage.value = '已挂起或已作废的退火记录不能推进；请重排挂起记录，作废记录需新建排位。'
      return null
    }
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  return {
    anneals,
    pieces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    wallThicknessOf,
    existingPlanOf,
    activeAnnealOf,
    basisThicknessOf,
    durationOfAnneal,
    conflictOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
  }
})
