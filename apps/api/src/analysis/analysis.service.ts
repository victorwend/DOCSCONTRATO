import { Injectable, Logger } from '@nestjs/common';
import { Db, Queryable } from '../db/pool';

/**
 * Ponto de extensão para OCR/IA (fase 9). A IA é ASSISTIVA: produz sugestões
 * (tipo de documento, nome, CPF/CNPJ, validade, legibilidade) que aparecem para o RH,
 * mas nunca aprova ou rejeita um documento sozinha.
 *
 * Para adicionar um provedor: implemente DocumentAnalyzer e registre-o em ANALYZERS.
 * Os resultados ficam em document_analyses.result (jsonb).
 */
export interface AnalysisResult {
  detectedType?: string;
  extracted?: { name?: string; cpf?: string; cnpj?: string; validUntil?: string };
  legibility?: 'OK' | 'LOW' | 'ILLEGIBLE';
  confidence?: number;
  notes?: string[];
}

export interface DocumentAnalyzer {
  readonly provider: string;
  analyze(input: { buffer: Buffer; mime: string; documentName: string }): Promise<AnalysisResult>;
}

const ANALYZERS: Record<string, DocumentAnalyzer> = {};

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly analyzer: DocumentAnalyzer | null = ANALYZERS[process.env.DOCUMENT_ANALYZER ?? 'none'] ?? null;

  constructor(private readonly db: Db) {}

  get enabled() {
    return !!this.analyzer;
  }

  /** Registra o arquivo para análise assíncrona (no MVP não há provedor configurado). */
  async enqueue(fileId: string, c: Queryable) {
    if (!this.analyzer) return;
    await this.db.exec(`insert into document_analyses (file_id, provider) values ($1, $2)`, [fileId, this.analyzer.provider], c);
  }

  async run(fileId: string, input: { buffer: Buffer; mime: string; documentName: string }) {
    if (!this.analyzer) return;
    try {
      const result = await this.analyzer.analyze(input);
      await this.db.exec(`update document_analyses set status='DONE', result=$2, finished_at=now() where file_id=$1 and status='PENDING'`, [fileId, JSON.stringify(result)]);
    } catch (e) {
      this.logger.warn(`Análise falhou para ${fileId}: ${(e as Error).message}`);
      await this.db.exec(`update document_analyses set status='FAILED', error=$2, finished_at=now() where file_id=$1 and status='PENDING'`, [fileId, String((e as Error).message)]);
    }
  }
}
