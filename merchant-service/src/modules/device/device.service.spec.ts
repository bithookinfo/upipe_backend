import { Test, TestingModule } from "@nestjs/testing";
import { DeviceService } from "./device.service";

describe("DeviceService", () => {
  let service: DeviceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeviceService],
    }).compile();

    service = module.get<DeviceService>(DeviceService);
  });

  describe("generateDeviceFingerprint", () => {
    it("should generate valid fingerprint string", () => {
      const fingerprint = service.generateDeviceFingerprint();

      expect(fingerprint).toBeDefined();
      expect(fingerprint).toContain("c2RtNjM2-cWNvbQ-");
      expect(fingerprint.length).toBeGreaterThan(10);
    });

    it("should generate unique fingerprints", () => {
      const fp1 = service.generateDeviceFingerprint();
      const fp2 = service.generateDeviceFingerprint();

      expect(fp1).not.toBe(fp2);
    });
  });

  describe("generateDeviceData", () => {
    it("should generate complete device data", () => {
      const deviceData = service.generateDeviceData();

      expect(deviceData.platform).toBe("ANDROID");
      expect(deviceData.version).toBe("11");
      expect(deviceData.fingerprint).toBeDefined();
      expect(deviceData.ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    });
  });

  describe("validateDeviceData", () => {
    it("should validate correct device data", () => {
      const validData = {
        platform: "ANDROID" as const,
        version: "11",
        fingerprint: "abc123",
        ip: "192.168.1.1",
      };

      const result = service.validateDeviceData(validData);

      expect(result).toBe(true);
    });

    it("should reject invalid platform", () => {
      const invalidData = {
        platform: "WINDOWS" as any,
        version: "11",
        fingerprint: "abc123",
        ip: "192.168.1.1",
      };

      const result = service.validateDeviceData(invalidData);

      expect(result).toBe(false);
    });

    it("should reject invalid IP format", () => {
      const invalidData = {
        platform: "ANDROID" as const,
        version: "11",
        fingerprint: "abc123",
        ip: "invalid-ip",
      };

      const result = service.validateDeviceData(invalidData);

      expect(result).toBe(false);
    });
  });
});
