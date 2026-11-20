import {
  $mpCE, $mpEv, $mpKey, $mpList, $mpTouchCatch, $rpx, $s,
  getTabBar, hoverDirective, longpressDirective, selectAllComponents, selectComponent, setData, triggerEvent,
} from './instance.js'
import MpButton from '../components/MpButton.vue'
import MpImage from '../components/MpImage.vue'
import MpInput from '../components/MpInput.vue'
import MpNavigator from '../components/MpNavigator.vue'
import MpPicker from '../components/MpPicker.vue'
import MpPickerView from '../components/MpPickerView.vue'
import MpPickerViewColumn from '../components/MpPickerViewColumn.vue'
import MpScrollView from '../components/MpScrollView.vue'
import MpSwitch from '../components/MpSwitch.vue'
import MpTextarea from '../components/MpTextarea.vue'
import MpVideo from '../components/MpVideo.vue'

export function installRuntime(app) {
  Object.assign(app.config.globalProperties, {
    setData,
    triggerEvent,
    selectComponent,
    selectAllComponents,
    getTabBar,
    $mpEv,
    $mpCE,
    $mpTouchCatch,
    $mpList,
    $mpKey,
    $s,
    $rpx,
  })
  app.directive('mp-hover', hoverDirective)
  app.directive('mp-longpress', longpressDirective)
  const builtins = {
    'mp-button': MpButton,
    'mp-image': MpImage,
    'mp-input': MpInput,
    'mp-navigator': MpNavigator,
    'mp-picker': MpPicker,
    'mp-picker-view': MpPickerView,
    'mp-picker-view-column': MpPickerViewColumn,
    'mp-scroll-view': MpScrollView,
    'mp-switch': MpSwitch,
    'mp-textarea': MpTextarea,
    'mp-video': MpVideo,
  }
  for (const [name, comp] of Object.entries(builtins)) app.component(name, comp)
  app.config.errorHandler = (err, vm, info) => {
    const where = (vm && (vm.route || vm.is)) || ''
    console.error(`[H5]${where ? ` ${where}` : ''} ${info}:`, err)
  }
}
