import { ElTable } from 'element-plus'

/**
 * 管理后台表格默认可拖拽调整列宽。
 * Element Plus：el-table 需 border，el-table-column 默认 resizable。
 */
export function setupResizableTables() {
  ElTable.props.border = {
    type: Boolean,
    default: true,
  }
}
