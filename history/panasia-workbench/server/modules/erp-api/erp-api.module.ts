import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DemoModule } from '../demo/demo.module';
import { ErpBridgeModule } from '../erp-bridge/erp-bridge.module';
import { ErpApiController } from './erp-api.controller';
import { ErpTokenService } from './erp-token.service';

@Module({
  imports: [DemoModule, HttpModule, ErpBridgeModule],
  controllers: [ErpApiController],
  providers: [ErpTokenService],
})
export class ErpApiModule {}
