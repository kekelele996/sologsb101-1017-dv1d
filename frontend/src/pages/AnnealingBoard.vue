<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排
 * 窑位冲突时禁用提交；出炉即回写作品状态为「已退火」。
 * 消费模型：Anneal、Piece、Furnace；复用组件：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import {
  ANNEAL_FILTER_STATE_OPTIONS,
  CURVE_SEG_OPTIONS,
  HELD_ANNEAL_STATE,
  VOID_ANNEAL_STATE,
  type Anneal,
  type AnnealDraft,
  type AnnealState,
  type CurveSeg,
} from '@/types/anneal'
import { ANNEAL_CURVE, formatHours, segmentHours, totalAnnealHours } from '@/utils/thermal'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<AnnealDraft>({
  pieceId: '',
  kilnSlot: '',
  curveSeg: '缓冷' as CurveSeg,
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
  basisWallThicknessMm: 4,
  basisDesignHeightMm: 0,
})

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  kilnSlot: [{ required: true, message: '请选择窑位', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择入窑时间', trigger: 'change' }],
  state: [{ required: true, message: '请选择退火状态', trigger: 'change' }],
}

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

const slotOptions = computed<string[]>(() => {
  const codes = furnaceStore.annealingFurnaces.map((row) => row.code)
  if (codes.length === 0) return annealStore.allSlots
  const list: string[] = []
  codes.forEach((code) => {
    for (let index = 0; index < 9; index += 1) {
      const row = String.fromCharCode(65 + Math.floor(index / 3))
      list.push(`${code}-${row}${(index % 3) + 1}`)
    }
  })
  return list
})

/** 当前表单的窑位冲突检测结果，冲突时禁用提交 */
const conflict = computed(() =>
  annealStore.conflictOf({
    id: editingId.value ?? '',
    kilnSlot: form.kilnSlot,
    inAt: form.inAt,
    outAt: form.outAt,
    curveSeg: form.curveSeg,
    pieceId: form.pieceId,
    state: form.state,
    basisWallThicknessMm: form.basisWallThicknessMm,
  })
)

const editingRow = computed<Anneal | null>(() =>
  editingId.value === null ? null : annealStore.anneals.find((row) => row.id === editingId.value) ?? null,
)

/** 挂起重试：从挂起记录编辑，冲突时仍保存在挂起侧；有效记录冲突则禁止覆盖 */
const canHoldOnConflict = computed<boolean>(() => editingRow.value?.state === HELD_ANNEAL_STATE)

const duplicateActive = computed<Anneal | null>(() => {
  const row = annealStore.existingPlanOf(form.pieceId, editingId.value ?? '')
  return row === undefined ? null : row
})

const duplicateMessage = computed<string>(() => {
  if (duplicateActive.value === null) return ''
  return duplicateActive.value.state === HELD_ANNEAL_STATE
    ? `已有挂起记录：${duplicateActive.value.kilnSlot}，请在该记录上重试排位。`
    : `既有有效记录：${duplicateActive.value.kilnSlot} · ${duplicateActive.value.state}；壁厚变更后请使用作废记录上的「按新壁厚重排」。`
})

watch(
  () => form.pieceId,
  (id) => {
    if (editingId.value !== null) return
    const piece = pieceStore.pieces.find((item) => item.id === id)
    if (piece === undefined) return
    form.basisWallThicknessMm = piece.wallThicknessMm
    form.basisDesignHeightMm = piece.designHeightMm
  },
)

const formDuration = computed(() => {
  const thickness = form.basisWallThicknessMm
  return {
    segment: formatHours(segmentHours(form.curveSeg, thickness)),
    total: formatHours(totalAnnealHours(thickness)),
    hint: ANNEAL_CURVE[form.curveSeg].hint,
  }
})

const dialogTitle = computed<string>(() => {
  if (editingId.value === null) return '分配退火窑位'
  return editingRow.value?.state === HELD_ANNEAL_STATE ? '重试退火排位' : '编辑退火编排'
})

const stats = computed(() => ({
  total: annealStore.anneals.length,
  waiting: annealStore.anneals.filter((row) => row.state === '待入窑').length,
  firing: annealStore.anneals.filter((row) => row.state === '退火中').length,
  done: annealStore.anneals.filter((row) => row.state === '已出炉').length,
  held: annealStore.anneals.filter((row) => row.state === HELD_ANNEAL_STATE).length,
  voided: annealStore.anneals.filter((row) => row.state === VOID_ANNEAL_STATE).length,
}))

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

function resetFormForPiece(pieceId: string): void {
  const piece = pieceStore.pieces.find((row) => row.id === pieceId)
  form.basisWallThicknessMm = piece?.wallThicknessMm ?? 4
  form.basisDesignHeightMm = piece?.designHeightMm ?? 0
}

function openCreate(): void {
  editingId.value = null
  const targetPieceId = pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? ''
  Object.assign(form, {
    pieceId: targetPieceId,
    kilnSlot: slotOptions.value[0] ?? 'AN-01-A1',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
  })
  resetFormForPiece(targetPieceId)
  dialogVisible.value = true
}

function openReschedule(row: Anneal): void {
  const piece = pieceStore.pieces.find((item) => item.id === row.pieceId)
  editingId.value = null
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnSlot: row.kilnSlot,
    curveSeg: row.curveSeg,
    inAt: row.inAt,
    outAt: row.outAt,
    state: '待入窑' as AnnealState,
    basisWallThicknessMm: piece?.wallThicknessMm ?? row.basisWallThicknessMm,
    basisDesignHeightMm: piece?.designHeightMm ?? row.basisDesignHeightMm,
  })
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  if (row.state === VOID_ANNEAL_STATE) {
    ElMessage.info('作废记录不可编辑；请使用「按新壁厚重排」生成新的退火记录。')
    return
  }
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnSlot: row.kilnSlot,
    curveSeg: row.curveSeg,
    inAt: row.inAt,
    outAt: row.outAt,
    state: row.state === HELD_ANNEAL_STATE ? ('待入窑' as AnnealState) : row.state,
    basisWallThicknessMm: row.basisWallThicknessMm,
    basisDesignHeightMm: row.basisDesignHeightMm,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (conflict.value.conflict && !canHoldOnConflict.value) {
    ElMessage.error(conflict.value.message)
    return
  }
  if (duplicateActive.value !== null && editingRow.value?.state !== HELD_ANNEAL_STATE) {
    ElMessage.error(
      duplicateActive.value.state === HELD_ANNEAL_STATE
        ? '该作品已有挂起重排，请在那条挂起记录上点「重试排位」，避免重复挂单。'
        : '该作品已有有效退火记录；壁厚变更后请从作废记录点「按新壁厚重排」。',
    )
    return
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await annealStore.createAnneal({ ...form })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      if (row.state === HELD_ANNEAL_STATE) {
        ElMessage.warning(annealStore.lastMessage)
      } else {
        ElMessage.success(`已分配窑位 ${row.kilnSlot}`)
      }
    } else {
      const ok = await annealStore.updateAnneal(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(annealStore.lastMessage)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Anneal): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除窑位 ${row.kilnSlot} 的退火记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await annealStore.deleteAnneal(row.id)
  ElMessage.success('退火记录已删除')
}

async function handleAdvance(row: Anneal): Promise<void> {
  const next = await annealStore.advance(row.id)
  if (next === null) {
    ElMessage.info('该记录已处于「已出炉」状态')
    return
  }
  ElMessage.success(annealStore.lastMessage)
}

function annealTagType(row: Anneal): 'info' | 'success' | 'warning' | 'primary' | 'danger' {
  if (row.state === '已出炉') return 'success'
  if (row.state === '退火中') return 'warning'
  if (row.state === HELD_ANNEAL_STATE) return 'danger'
  if (row.state === VOID_ANNEAL_STATE) return 'info'
  return 'primary'
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'curveSeg') annealStore.setFilters({ curveSeg: value as CurveSeg | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="退火记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="待入窑" :value="stats.waiting" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="退火中" :value="stats.firing" suffix="条" tone="warning" icon="TrendCharts" />
      <StatBadge label="已挂起" :value="stats.held" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="已作废" :value="stats.voided" suffix="条" tone="default" icon="Histogram" />
      <StatBadge label="已出炉" :value="stats.done" suffix="条" tone="success" icon="PieChart" />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`已占用 ${annealStore.occupiedSlotCount} / ${annealStore.allSlots.length} 个窑位`"
      />
    </div>

    <el-alert
      v-if="annealStore.lastMessage !== ''"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="annealStore.lastMessage"
    />

    <el-alert
      v-if="stats.held > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${stats.held} 条重排因撞时间窗挂起，等待排产员调整窑位或入窑时间`"
      description="挂起记录不会占用窑位，也不会改动已占记录；请在操作列点「重试排位」。"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火窑位分配与曲线编排</span>
          <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0 || slotOptions.length === 0">
            <el-icon><Plus /></el-icon>
            <span>分配窑位</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'state', label: '退火状态', options: ANNEAL_FILTER_STATE_OPTIONS as unknown as string[] },
          { key: 'curveSeg', label: '曲线段', options: CURVE_SEG_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          state: annealStore.filters.state,
          curveSeg: annealStore.filters.curveSeg,
          kilnCode: annealStore.filters.kilnCode,
        }"
        :result-text="`命中 ${annealStore.visibleAnneals.length} / ${annealStore.anneals.length} 条`"
        @update:keyword="(value: string) => annealStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="annealStore.resetFilters()"
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.anneals.length === 0"
        title="还没有退火编排"
        description="为已完成全部工序的作品分配退火窑位与曲线段；同一窑位在时间窗重叠时会禁止提交。"
        action-text="分配第一个窑位"
        @action="openCreate"
      />

      <el-table v-else v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">
                排位依据壁厚 {{ row.basisWallThicknessMm }} mm · 当前壁厚
                {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 该段
                {{ annealStore.durationOfAnneal(row.id).text }}
                <el-tag v-if="row.state === '已作废'" size="small" type="info" effect="plain">已等待新壁厚排位</el-tag>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="150">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column prop="kilnSlot" label="窑位" width="130" />
        <el-table-column label="曲线段" width="120">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'"
            >
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="该段时长" width="120" align="right">
          <template #default="{ row }">
            {{ formatHours(segmentHours(row.curveSeg, row.basisWallThicknessMm)) }}
          </template>
        </el-table-column>
        <el-table-column label="入窑时间" width="160">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="出炉时间" width="160">
          <template #default="{ row }">
            <span v-if="row.outAt === ''" class="cell-sub">未出炉</span>
            <span v-else>{{ row.outAt.replace('T', ' ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="annealTagType(row)" :effect="row.state === '已挂起' || row.state === '已出炉' ? 'dark' : 'light'">
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="生命周期说明" min-width="220">
          <template #default="{ row }">
            <span v-if="row.lifecycleNote === ''" class="cell-sub">—</span>
            <span v-else :class="{ 'cell-warn': row.state === '已挂起' }">{{ row.lifecycleNote }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :disabled="row.state === '已出炉' || row.state === '已挂起' || row.state === '已作废'"
              @click="handleAdvance(row)"
            >
              推进状态
            </el-button>
            <el-button v-if="row.state === '已挂起'" link type="warning" size="small" @click="openEdit(row)">
              重试排位
            </el-button>
            <el-button v-else-if="row.state === '已作废'" link type="warning" size="small" @click="openReschedule(row)">
              按新壁厚重排
            </el-button>
            <el-button v-else link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">窑位占用表</span>
      </template>
      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{ 'is-occupied': annealStore.occupancy.some((row) => row.kilnSlot === slot && row.occupied) }"
        >
          <div class="slot-name">{{ slot }}</div>
          <template v-for="row in annealStore.occupancy.filter((item) => item.kilnSlot === slot)" :key="row.annealId">
            <div class="slot-detail" :class="{ 'is-held': !row.occupied }">
              {{ row.pieceName }} · {{ row.curveSeg }} · {{ row.state }}
            </div>
          </template>
          <div v-if="annealStore.occupancy.filter((item) => item.kilnSlot === slot).length === 0" class="slot-detail is-free">
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="660px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作品" prop="pieceId">
              <el-select v-model="form.pieceId" filterable style="width: 100%">
                <el-option
                  v-for="item in pieceStore.pieces"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="退火窑位" prop="kilnSlot">
              <el-select v-model="form.kilnSlot" filterable style="width: 100%">
                <el-option v-for="slot in slotOptions" :key="slot" :value="slot" :label="slot" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="曲线段" prop="curveSeg">
              <el-select v-model="form.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="生命周期">
              <el-input :model-value="editingRow?.state ?? '待入窑'" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="依据壁厚">
              <el-input-number v-model="form.basisWallThicknessMm" disabled :min="0.5" :max="60" :step="0.1" :precision="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="入窑时间" prop="inAt">
              <el-date-picker
                v-model="form.inAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出炉时间">
              <el-date-picker
                v-model="form.outAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                placeholder="未出炉可留空"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="依据高度">
              <el-input-number v-model="form.basisDesignHeightMm" disabled :min="0" :max="2000" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-alert
          v-if="duplicateActive !== null && editingRow?.state !== HELD_ANNEAL_STATE"
          type="warning"
          show-icon
          :closable="false"
          title="该作品已有未完成退火计划，不会重复占位"
          :description="duplicateMessage"
        />
        <el-alert
          v-else-if="conflict.conflict"
          :type="canHoldOnConflict ? 'warning' : 'error'"
          show-icon
          :closable="false"
          :title="canHoldOnConflict ? '重试仍撞时间窗，将继续挂起' : '本次新排位撞时间窗，将挂起等待人工确认'"
          :description="`${conflict.message} 已占记录不会被改动，挂起记录也不占用窑位。`"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="窑位可用，可以提交"
          :description="`排位依据壁厚 ${form.basisWallThicknessMm} mm；当前曲线段「${form.curveSeg}」理论时长 ${formDuration.segment}，全流程退火 ${formDuration.total}。${formDuration.hint}`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="conflict.conflict && !canHoldOnConflict"
          @click="handleSubmit"
        >
          {{ conflict.conflict && canHoldOnConflict ? '保存挂起重试' : '保存' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}

.slot-cell {
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafcff;
}

.slot-cell.is-occupied {
  border-color: #f0b27a;
  background: #fff8f1;
}

.slot-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7a;
}

.slot-detail.is-free {
  color: #a8b0b8;
}

.slot-detail.is-held {
  color: #c0392b;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
