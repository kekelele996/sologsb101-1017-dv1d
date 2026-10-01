/**
 * 退火（Anneal）
 * 窑位分配与曲线段编排由排产员维护；操作侧只更新吹制工序，不覆盖退火状态。
 * 退火记录保存排位时使用的壁厚快照，作品壁厚随后变化时，原记录作废并等待重排。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉 / 已挂起 / 已作废 */
export type AnnealState = '待入窑' | '退火中' | '已出炉' | '已挂起' | '已作废'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉', '已挂起', '已作废']

/** 排产员可主动设置的在窑生命周期状态；挂起与作废由系统规则生成 */
export const ANNEAL_ACTIVE_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 过滤栏展示的状态 */
export const ANNEAL_FILTER_STATE_OPTIONS: AnnealState[] = [
  '待入窑',
  '退火中',
  '已出炉',
  '已挂起',
  '已作废',
]

/** 状态推进顺序（挂起记录恢复后按其中保存的目标状态继续） */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 不占用窑位、也不代表有效退火计划的状态 */
export const NON_OCCUPYING_ANNEAL_STATES: AnnealState[] = ['已挂起', '已作废']

/** 作废记录不能继续推进或编辑，只能作为重排依据 */
export const VOID_ANNEAL_STATE: AnnealState = '已作废'

/** 重排冲突时挂起，等待排产员调整窑位或时间 */
export const HELD_ANNEAL_STATE: AnnealState = '已挂起'

export function isAnnealState(value: unknown): value is AnnealState {
  return typeof value === 'string' && (ANNEAL_STATE_OPTIONS as string[]).includes(value)
}

export function isAnnealOccupying(state: AnnealState): boolean {
  return !NON_OCCUPYING_ANNEAL_STATES.includes(state)
}

export function isAnnealVoid(state: AnnealState): boolean {
  return state === VOID_ANNEAL_STATE
}

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 退火窑号 + 窑位，如 AN-01-A1 */
  kilnSlot: string
  /** 曲线段 */
  curveSeg: CurveSeg
  /** 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  /** 排位时作品壁厚快照（mm），退火时间窗按该尺寸计算 */
  basisWallThicknessMm: number
  /** 排位时作品设计高度快照（mm），仅作追溯 */
  basisDesignHeightMm: number
  /** 作废 / 挂起原因；正常记录为空串 */
  lifecycleNote: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑退火的表单草稿；仅包含排产员可写字段 */
export interface AnnealDraft {
  pieceId: string
  kilnSlot: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  basisWallThicknessMm: number
  basisDesignHeightMm: number
}
