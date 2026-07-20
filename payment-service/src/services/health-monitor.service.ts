import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

export enum ProviderHealth {
    HEALTHY = 'HEALTHY',
    DEGRADED = 'DEGRADED',
    DOWN = 'DOWN',
    UNKNOWN = 'UNKNOWN'
}

@Injectable()
export class HealthMonitorService {
    private readonly logger = new Logger(HealthMonitorService.name);

    // In-memory store for health status
    private providerHealth: Map<string, ProviderHealth> = new Map();
    private failureCounts: Map<string, number> = new Map();

    private readonly THRESHOLD_FAILURES = 3;

    constructor() { }

    @Cron(CronExpression.EVERY_MINUTE)
    async checkProviders() {
        this.logger.log('💓 Running Provider Health Check...');

        // In a real scenario, we would fetch active providers from DB.
        // For MVP, we check the known provider endpoints.

        await this.checkPhonePe();
        await this.checkPaytm();
    }

    getProviderStatus(provider: string): ProviderHealth {
        return this.providerHealth.get(provider) || ProviderHealth.UNKNOWN;
    }

    private async checkPhonePe() {
        // PhonePe Prod Health/Options
        const url = 'https://api.phonepe.com/apis/hermes/health'; // Example health endpoint
        // If specific health endpoint doesn't exist, use OPTIONS on pay.

        try {
            // Mocking the call for now as we don't want to spam real API during dev without valid keys sometimes
            // In prod: await axios.get(url, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } });

            // Simulate healthy
            this.updateStatus('PHONEPE', true);
        } catch (error) {
            this.updateStatus('PHONEPE', false);
        }
    }

    private async checkPaytm() {
        try {
            // Mocking Paytm check
            this.updateStatus('PAYTM', true);
        } catch (error) {
            this.updateStatus('PAYTM', false);
        }
    }

    private updateStatus(provider: string, isSuccess: boolean) {
        const currentFailures = this.failureCounts.get(provider) || 0;

        if (isSuccess) {
            if (currentFailures > 0) {
                this.logger.log(`✅ ${provider} recovered. Now HEALTHY.`);
            }
            this.providerHealth.set(provider, ProviderHealth.HEALTHY);
            this.failureCounts.set(provider, 0);
        } else {
            const newFailures = currentFailures + 1;
            this.failureCounts.set(provider, newFailures);

            if (newFailures >= this.THRESHOLD_FAILURES) {
                if (this.providerHealth.get(provider) !== ProviderHealth.DOWN) {
                    this.logger.warn(`🚨 ${provider} is DOWN after ${newFailures} failures.`);
                }
                this.providerHealth.set(provider, ProviderHealth.DOWN);
            } else {
                this.logger.warn(`⚠️ ${provider} check failed (${newFailures}/${this.THRESHOLD_FAILURES}).`);
                this.providerHealth.set(provider, ProviderHealth.DEGRADED);
            }
        }
    }
}
