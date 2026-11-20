import { Module } from '@nestjs/common';

import { HostedCustomersController } from './hosted-customers.controller';
import { HostedCustomersAdminController } from './hosted-customers.admin.controller';
import { HostedCustomersService } from './hosted-customers.service';

@Module({
  controllers: [HostedCustomersController, HostedCustomersAdminController],
  providers: [HostedCustomersService],
})
export class HostedCustomersModule {}
