/**
 * 退火（Anneal）
 * 窑位分配与曲线段编排；窑位时间窗冲突时禁用提交，出炉即回写作品状态。
 * 排产员持有：窑位、曲线段、入窑/出炉时间；时间窗按作品壁厚计算，
 * 排位时把当时壁厚快照为「依据尺寸」，排位后壁厚若改动，该条记录即作废，
 * 等排产员按新壁厚重排；重排撞窗则挂起等人定，绝不改动已占记录。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉 / 已作废 / 已挂起 */
export type AnnealState = '待入窑' | '退火中' | '已出炉' | '已作废' | '已挂起'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉', '已作废', '已挂起']

/** 状态推进顺序（作废 / 挂起 为系统态，不在推进链上） */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 占用窑位的状态：待入窑 / 退火中；已出炉、已作废、已挂起 均不占位 */
export const OCCUPYING_ANNEAL_STATES: AnnealState[] = ['待入窑', '退火中']

/** 作废：排位依据的壁厚在排位后被改动，时间窗失效，等排产员按新壁厚重排；记录保留不删 */
export const ANNEAL_VOIDED: AnnealState = '已作废'
/** 挂起：重排撞了时间窗，等人调整窑位/时间后重试；不动已占记录 */
export const ANNEAL_SUSPENDED: AnnealState = '已挂起'

/** 该状态是否仍占用窑位（待入窑 / 退火中） */
export function annealOccupies(state: AnnealState): boolean {
  return (OCCUPYING_ANNEAL_STATES as AnnealState[]).includes(state)
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
  /** 排位依据壁厚（mm）：时间窗按它计算；排位后壁厚若改动，记录作废并重排 */
  basisWallThicknessMm: number
  /** 作废 / 挂起原因（正常排位为空串） */
  voidReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑退火的表单草稿（依据壁厚与作废原因由 store 按作品当前壁厚快照，不入表单） */
export interface AnnealDraft {
  pieceId: string
  kilnSlot: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
}
