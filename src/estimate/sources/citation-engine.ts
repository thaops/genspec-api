import { Injectable } from '@nestjs/common';
import { PriceSource } from '../estimate.types';
import { DOCUMENT_REGISTRY, OfficialDocument, getRelevantDocuments } from './document-registry';
import { SOURCE_REGISTRY, OfficialSource, getSourcesForRegion } from './source-registry';

export interface Citation {
  documentNumber?: string;
  documentTitle?: string;
  issuedDate?: string;
  effectiveDate?: string;
  sourceName: string;
  sourceType: string;
  priority: number;
  url?: string;
  isVerified: boolean;
}

@Injectable()
export class CitationEngineService {
  enrich(source: PriceSource, region?: string): Citation {
    const docMatch = this.matchDocument(source);
    if (docMatch) {
      const src = SOURCE_REGISTRY.find((s) => s.id === docMatch.sourceId);
      return {
        documentNumber: docMatch.number,
        documentTitle: docMatch.title,
        issuedDate: docMatch.issuedDate,
        effectiveDate: docMatch.effectiveDate,
        sourceName: src?.name ?? source.name ?? '',
        sourceType: source.type ?? 'government',
        priority: src?.priority ?? 1,
        url: source.url,
        isVerified: true,
      };
    }

    const srcMatch = this.matchSource(source, region);
    if (srcMatch) {
      return {
        sourceName: srcMatch.name,
        sourceType: srcMatch.type,
        priority: srcMatch.priority,
        url: source.url,
        isVerified: true,
      };
    }

    return {
      sourceName: source.name ?? 'Không rõ nguồn',
      sourceType: source.type ?? 'ai_estimate',
      priority: source.type === 'government' ? 1 : source.type === 'supplier' ? 2 : 3,
      url: source.url,
      isVerified: false,
    };
  }

  buildDocumentContext(tags: string[], region?: string): string {
    const docs = getRelevantDocuments(tags);
    const sources = getSourcesForRegion(region);

    const docList = docs
      .map(
        (d) =>
          `[${d.number}] ${d.title} (ban hành: ${d.issuedDate}${d.effectiveDate ? ', hiệu lực: ' + d.effectiveDate : ''}) — ${d.summary}`,
      )
      .join('\n');

    const srcList = sources
      .filter((s) => s.priority <= 2)
      .map((s) => `[${s.shortName}] ${s.name}${s.domain ? ' (' + s.domain + ')' : ''} — ${s.description}`)
      .join('\n');

    return [
      docList ? `VĂN BẢN PHÁP QUY HIỆN HÀNH:\n${docList}` : '',
      srcList ? `\nNGUỒN GIÁ CHÍNH THỐNG:\n${srcList}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private matchDocument(source: PriceSource): OfficialDocument | undefined {
    const hay = `${source.name ?? ''} ${source.url ?? ''}`.toLowerCase();
    return DOCUMENT_REGISTRY.find((d) => {
      const numLower = d.number.toLowerCase().replace(/\s/g, '');
      const hayNoSpace = hay.replace(/\s/g, '');
      return hayNoSpace.includes(numLower) || hay.includes(d.number.toLowerCase()) || hay.includes(d.id.replace(/_/g, ' '));
    });
  }

  private matchSource(source: PriceSource, region?: string): OfficialSource | undefined {
    const hay = `${source.name ?? ''} ${source.url ?? ''}`.toLowerCase();
    const candidates = region ? getSourcesForRegion(region) : SOURCE_REGISTRY;
    return candidates.find(
      (s) =>
        (s.domain && hay.includes(s.domain)) ||
        hay.includes(s.shortName.toLowerCase()) ||
        hay.includes(s.name.toLowerCase()),
    );
  }
}
