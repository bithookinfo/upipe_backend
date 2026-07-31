import { Injectable, Logger } from '@nestjs/common';

export interface GpayParsedTransaction {
  txnId: string;
  utr: string | null;
  timestamp: Date;
  amount: number;
  customerName: string | null;
  customerVpa: string | null;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  note: string | null;
  rawRecord?: any;
}

@Injectable()
export class GpayRpcParserService {
  private readonly logger = new Logger(GpayRpcParserService.name);

  /**
   * Parse batchexecute response lines into RPC messages [{ rpcId, data }]
   */
  parseBatchexecuteLines(rawLine: string): { rpcId: string; data: any }[] {
    const results: { rpcId: string; data: any }[] = [];
    if (!rawLine || !rawLine.trim()) return results;

    try {
      let clean = rawLine.trim();
      if (clean.startsWith(")]}'")) {
        clean = clean.substring(4).trim();
      }
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed)) return results;

      for (const item of parsed) {
        if (!Array.isArray(item) || !item[2]) continue;
        const rpcId = String(item[1]);
        try {
          const innerData = JSON.parse(item[2]);
          results.push({ rpcId, data: innerData });
        } catch (e: any) {
          this.logger.debug(
            `Failed to parse inner RPC json for ${rpcId}: ${e.message}`,
          );
        }
      }
    } catch {
      // Line is not JSON or chunked format
    }

    return results;
  }

  /**
   * Find the real transaction array inside deeply nested RPtkab structures
   */
  findRealTxnList(data: any, depth = 0): any[] | null {
    if (depth > 6 || !data) return null;
    if (
      Array.isArray(data) &&
      data.length > 0 &&
      Array.isArray(data[0]) &&
      typeof data[0][0] === 'string' &&
      data[0].length >= 5
    ) {
      return data;
    }
    if (Array.isArray(data) && data.length === 1 && Array.isArray(data[0])) {
      return this.findRealTxnList(data[0], depth + 1);
    }
    if (Array.isArray(data)) {
      for (const el of data) {
        const found = this.findRealTxnList(el, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Parse RPtkab (initial batchexecute list of transactions)
   */
  parseRPtkabPayload(data: any): GpayParsedTransaction[] {
    const txnList = this.findRealTxnList(data);
    if (!txnList || !Array.isArray(txnList)) return [];

    const parsedTxns: GpayParsedTransaction[] = [];
    for (const raw of txnList) {
      const parsed = this.parseTxnRecord(raw);
      if (parsed) {
        parsedTxns.push(parsed);
      }
    }
    return parsedTxns;
  }

  /**
   * Parse yuZqtb (real-time single payment push from Google)
   */
  parseYuZqtbPayload(data: any): GpayParsedTransaction | null {
    if (!data || !Array.isArray(data)) return null;
    const r = Array.isArray(data[0]) && data[0].length > 3 ? data[0] : data;
    if (!r[0]) return null;

    return this.parseTxnRecord(r);
  }

  /**
   * Parse a raw Google Pay transaction record array
   * Mapping:
   * r[0]  = GPay internal transaction ID
   * r[1]  = UPI Reference Number (UTR/RRN)
   * r[2]  = [epoch_seconds, nanos] timestamp
   * r[3]  = ["INR", amount_in_rupees]
   * r[4]  = direction flag (1=received, 2=sent)
   * r[5]  = status (1/3/4=COMPLETED, else PENDING)
   * r[8]  = [name, UPI VPA, ...] payer info
   * r[9]  = description/note
   */
  parseTxnRecord(record: any): GpayParsedTransaction | null {
    if (!record || !Array.isArray(record)) return null;
    const r = Array.isArray(record[0]) && record[0].length > 3 ? record[0] : record;
    if (!r[0]) return null;

    const txnId = String(r[0]);
    const utr = r[1] ? String(r[1]) : null;

    const timestampSeconds = Array.isArray(r[2]) ? Number(r[2][0]) : null;
    const timestampNanos = Array.isArray(r[2]) ? Number(r[2][1] || 0) : 0;
    const timestamp = timestampSeconds
      ? new Date(timestampSeconds * 1000 + Math.floor(timestampNanos / 1_000_000))
      : new Date();

    const amount = Array.isArray(r[3])
      ? Number(r[3][1])
      : typeof r[3] === 'number'
        ? r[3]
        : Number(r[3]) || 0;
    const statusCode = r[5];
    const status = this.mapGPayStatus(statusCode);

    const payerInfo = Array.isArray(r[8]) ? r[8] : [];
    const customerName = typeof payerInfo[0] === 'string' ? payerInfo[0] : null;
    const customerVpa = typeof payerInfo[1] === 'string' ? payerInfo[1] : null;

    const note = typeof r[9] === 'string' ? r[9] : null;

    return {
      txnId,
      utr: utr && utr.length > 3 ? utr : null,
      timestamp,
      amount,
      customerName,
      customerVpa,
      status,
      note,
      rawRecord: r,
    };
  }

  mapGPayStatus(status: any): 'COMPLETED' | 'PENDING' | 'FAILED' {
    if (
      status === 1 ||
      status === 3 ||
      status === 4 ||
      status === 'COMPLETED' ||
      status === 'SUCCESS' ||
      status === 'SUCCESSFUL'
    ) {
      return 'COMPLETED';
    }
    if (status === 'FAILED' || status === 2 || status === 5) {
      return 'FAILED';
    }
    return 'PENDING';
  }

  /**
   * Check if timestamp is within -60s to +300s window relative to now
   */
  isWithinRealtimeWindow(
    timestamp: Date,
    referenceTimeMs = Date.now(),
  ): boolean {
    const diffSeconds = (timestamp.getTime() - referenceTimeMs) / 1000;
    // -60s to +300s
    return diffSeconds >= -60 && diffSeconds <= 300;
  }

  parseBatchexecuteResponse(raw: string): any[] {
    const lines = this.parseBatchexecuteLines(raw);
    const txns: any[] = [];
    for (const line of lines) {
      if (line.rpcId === 'RPtkab') {
        const parsedList = this.parseRPtkabPayload(line.data);
        for (const t of parsedList) {
          if (t.status === 'COMPLETED' && t.amount > 0) {
            txns.push({
              transactionId: t.txnId,
              amount: t.amount,
              utr: t.utr,
              customerName: t.customerName,
              payerVpa: t.customerVpa,
              timestamp: t.timestamp,
            });
          }
        }
      }
    }
    return txns;
  }

  parsePushNotification(raw: string): any | null {
    try {
      const parsed = JSON.parse(raw);
      const t = this.parseYuZqtbPayload(parsed);
      if (t && t.amount > 0) {
        return {
          transactionId: t.txnId,
          amount: t.amount,
          utr: t.utr,
          customerName: t.customerName,
          payerVpa: t.customerVpa,
          timestamp: t.timestamp,
        };
      }
    } catch {
      // invalid json
    }
    return null;
  }
}
