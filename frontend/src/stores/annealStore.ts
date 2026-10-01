/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW, annealOccupies } from '../types/anneal'
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
  annealBasisThickness,
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

  /** 退火记录的排位依据壁厚：优先快照 basisWallThicknessMm，缺失回退当前壁厚 */
  const basisOf = (row: Anneal): number => annealBasisThickness(row, wallThicknessOf(row.pieceId))

  /** 某条在排记录的依据壁厚是否已落后于作品当前壁厚（落后即已作废，需重排） */
  const isBasisStale = (row: Anneal): boolean =>
    annealOccupies(row.state) && Math.abs(basisOf(row) - wallThicknessOf(row.pieceId)) > 0.0001

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表（已作废 / 已挂起 / 已出炉 均不占位） */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          occupied: annealOccupies(row.state),
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

  /** 某件作品的窑位冲突检测（编辑 / 重排时排除自身；时间窗按排位依据壁厚计算） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'> & {
      basisWallThicknessMm?: number
    },
  ): SlotConflict {
    const editing = candidate.id === '' ? undefined : anneals.value.find((row) => row.id === candidate.id)
    // 依据壁厚取值：显式传入 > 既有记录快照 > 作品当前壁厚（新建场景）
    const basis =
      candidate.basisWallThicknessMm !== undefined && candidate.basisWallThicknessMm > 0
        ? candidate.basisWallThicknessMm
        : editing
          ? basisOf(editing)
          : wallThicknessOf(candidate.pieceId)
    return checkSlotConflict(
      anneals.value,
      { ...candidate, basisWallThicknessMm: basis },
      wallThicknessOf,
      candidate.id,
    )
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
    // 已排不重复占位：同一件作品已有在排（待入窑 / 退火中）记录时不再新建
    const duplicated = anneals.value.find(
      (row) => row.pieceId === draft.pieceId && annealOccupies(row.state),
    )
    if (duplicated !== undefined) {
      lastMessage.value = `该作品已有在排退火记录（${duplicated.kilnSlot} · ${duplicated.state}），不重复占位；如需调整请编辑或重排既有记录。`
      return null
    }
    const basis = wallThicknessOf(draft.pieceId)
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
      basisWallThicknessMm: basis,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      basisWallThicknessMm: basis,
      voidReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，依据壁厚 ${basis} mm，理论时长 ${formatHours(
      segmentHours(row.curveSeg, basis),
    )}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    const wasInactive = !annealOccupies(existing.state)
    // 作废 / 挂起 记录的编辑按「重试」处理：按作品当前壁厚重新校验时间窗，通过则恢复为「待入窑」
    const basis = wasInactive ? wallThicknessOf(draft.pieceId) : basisOf(existing)
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
      basisWallThicknessMm: basis,
    })
    if (conflict.conflict) {
      if (wasInactive) {
        // 重试仍撞窗：保持挂起并记录原因，绝不改动其他已占记录
        await putAnneal({
          ...existing,
          kilnSlot: draft.kilnSlot,
          curveSeg: draft.curveSeg,
          inAt: draft.inAt,
          outAt: draft.outAt,
          basisWallThicknessMm: basis,
          state: '已挂起',
          voidReason: conflict.message,
        })
        revision.value += 1
        lastMessage.value = `重排仍撞时间窗，已挂起等人调整窑位/时间：${conflict.message}`
        return false
      }
      lastMessage.value = conflict.message
      return false
    }
    if (wasInactive) {
      await putAnneal({
        ...existing,
        kilnSlot: draft.kilnSlot,
        curveSeg: draft.curveSeg,
        inAt: draft.inAt,
        outAt: draft.outAt,
        basisWallThicknessMm: basis,
        state: '待入窑',
        voidReason: '',
      })
      revision.value += 1
      lastMessage.value = `重排成功：已按当前壁厚 ${basis} mm 恢复窑位 ${draft.kilnSlot}`
      return true
    }
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
    })
    revision.value += 1
    lastMessage.value = '退火编排已更新'
    return true
  }

  /**
   * 重排作废 / 挂起记录（从排产这侧重试）：按作品当前壁厚重新校验时间窗。
   * - 不新建记录、不重复占位（更新同一条，冲突排除自身与其他不占位记录）；
   * - 撞窗则置「已挂起」等人定，绝不改动其他已占记录；
   * - 操作工的工序记录与本条作废 annealing 记录都保留。
   * 返回 rescheduled（已恢复）/ suspended（已挂起）/ skipped（在排或不存在，无需重排）。
   */
  async function rescheduleAnneal(
    annealId: string,
  ): Promise<'rescheduled' | 'suspended' | 'skipped'> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return 'skipped'
    if (annealOccupies(existing.state)) return 'skipped'
    const basis = wallThicknessOf(existing.pieceId)
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: existing.kilnSlot,
      inAt: existing.inAt,
      outAt: existing.outAt,
      curveSeg: existing.curveSeg,
      pieceId: existing.pieceId,
      basisWallThicknessMm: basis,
    })
    if (conflict.conflict) {
      await putAnneal({
        ...existing,
        basisWallThicknessMm: basis,
        state: '已挂起',
        voidReason: conflict.message,
      })
      revision.value += 1
      lastMessage.value = `重排撞时间窗，已挂起等人调整窑位/时间：${conflict.message}`
      return 'suspended'
    }
    await putAnneal({
      ...existing,
      basisWallThicknessMm: basis,
      state: '待入窑',
      voidReason: '',
    })
    revision.value += 1
    lastMessage.value = `重排成功：已按新壁厚 ${basis} mm 恢复窑位 ${existing.kilnSlot}`
    return 'rescheduled'
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
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
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
    basisOf,
    isBasisStale,
    conflictOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    rescheduleAnneal,
    advance,
  }
})
