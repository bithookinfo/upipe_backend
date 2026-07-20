import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DeviceDataDto } from "../../dto/phonepe-onboarding.dto";

@Injectable()
export class DeviceService implements OnModuleInit {
  private readonly logger = new Logger(DeviceService.name);
  private readonly platforms = ["ANDROID", "IOS", "WEB"] as const;

  constructor() {}

  onModuleInit() {
    this.logger.log("DeviceService initialized");
  }

  generateDeviceFingerprint(): string {
    // Match PHP format: 16 random hex chars + 'c2RtNjM2-cWNvbQ-'
    // PHP: $mom = RandomStriing(16); $deviceFingerprint=''.$mom.'c2RtNjM2-cWNvbQ-';
    const hexChars = "0123456789abcdef";
    let randomHex = "";
    for (let i = 0; i < 16; i++) {
      randomHex += hexChars[Math.floor(Math.random() * 16)];
    }
    return `${randomHex}c2RtNjM2-cWNvbQ-`;
  }

  generateDeviceData(): DeviceDataDto {
    return {
      platform: "ANDROID",
      version: "11",
      fingerprint: this.generateDeviceFingerprint(),
      ip: this.generateRandomIP(),
    };
  }

  private generateRandomIP(): string {
    const segments = Array(4)
      .fill(0)
      .map(() => Math.floor(Math.random() * 240) + 1);
    return segments.join(".");
  }

  validateDeviceData(data: DeviceDataDto): boolean {
    if (!this.platforms.includes(data.platform as any)) {
      return false;
    }

    const ipPattern = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    if (!ipPattern.test(data.ip)) {
      return false;
    }

    return true;
  }
}
