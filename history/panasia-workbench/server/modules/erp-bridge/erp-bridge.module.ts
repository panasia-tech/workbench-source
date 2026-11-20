import { Module } from '@nestjs/common';
import { DemoModule } from '../demo/demo.module';
import { ErpBridgeController } from './erp-bridge.controller';
import { ErpBridgeOpenApiController } from './erp-bridge-openapi.controller';
import { ErpBridgeService } from './erp-bridge.service';

@Module({
  imports: [DemoModule],
  controllers: [ErpBridgeController, ErpBridgeOpenApiController],
  providers: [ErpBridgeService],
  // erp-api 模块复用绑定口径（getBindingState / ErpCaller）
  exports: [ErpBridgeService],
})
export class ErpBridgeModule {}
