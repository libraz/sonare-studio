import { describe, expect, it, vi } from 'vitest';
import {
  consumeScorePagesSnapshot,
  MAX_SCORE_EXPORT_PAGES,
  renderScorePagesSnapshot,
} from '@/ui/score/use-score-notation';

describe('renderScorePagesSnapshot', () => {
  it('renders each page once from detached XML and layout snapshots', async () => {
    const seen: { xml?: string; layout?: Record<string, unknown> } = {};
    const client = {
      load: vi.fn(async (xml: string, layout?: Record<string, unknown>) => {
        seen.xml = xml;
        seen.layout = layout;
        return 3;
      }),
      renderPage: vi.fn(async (page: number) => `<svg data-page="${page}"/>`),
    };
    const layout = { pageWidth: 2100, pageHeight: 2970, scale: 40 };
    const promise = renderScorePagesSnapshot(client, '<score-partwise id="snapshot"/>', layout);
    layout.scale = 99;

    await expect(promise).resolves.toEqual([
      '<svg data-page="1"/>',
      '<svg data-page="2"/>',
      '<svg data-page="3"/>',
    ]);
    expect(seen.xml).toBe('<score-partwise id="snapshot"/>');
    expect(seen.layout).toEqual({ pageWidth: 2100, pageHeight: 2970, scale: 40 });
    expect(seen.layout).not.toBe(layout);
    expect(client.renderPage.mock.calls).toEqual([[1], [2], [3]]);
  });

  it('checks cancellation after every await and stops consuming later pages', async () => {
    let current = true;
    const client = {
      load: vi.fn(async () => 3),
      renderPage: vi.fn(async (page: number) => {
        if (page === 1) current = false;
        return `<svg data-page="${page}"/>`;
      }),
    };

    await expect(
      renderScorePagesSnapshot(client, '<score-partwise/>', {}, undefined, () => current),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.renderPage).toHaveBeenCalledTimes(1);
  });

  it('hands pages to a consumer in order without building a retained page array', async () => {
    const consumed: string[] = [];
    const client = {
      load: vi.fn(async () => 3),
      renderPage: vi.fn(async (page: number) => `<svg data-page="${page}"/>`),
    };

    await expect(
      consumeScorePagesSnapshot(client, '<score-partwise/>', {}, async (svg, page, count) => {
        consumed.push(`${page}/${count}:${svg}`);
      }),
    ).resolves.toBe(3);
    expect(consumed).toEqual([
      '1/3:<svg data-page="1"/>',
      '2/3:<svg data-page="2"/>',
      '3/3:<svg data-page="3"/>',
    ]);
  });

  it('rejects pathological page counts before rendering any SVG', async () => {
    const client = {
      load: vi.fn(async () => MAX_SCORE_EXPORT_PAGES + 1),
      renderPage: vi.fn(async () => '<svg/>'),
    };
    await expect(renderScorePagesSnapshot(client, '<score-partwise/>', {})).rejects.toThrow(
      /page count.*exceeds limit/,
    );
    expect(client.renderPage).not.toHaveBeenCalled();
  });

  it('keeps the measured raw-SVG peak to one page across a 500-page score', async () => {
    const svg = `<svg>${'譜'.repeat(256)}</svg>`;
    const samples: Array<{ activeBytes: number; peakActiveBytes: number }> = [];
    const client = {
      load: vi.fn(async () => MAX_SCORE_EXPORT_PAGES),
      renderPage: vi.fn(async () => svg),
    };

    await expect(
      consumeScorePagesSnapshot(
        client,
        '<score-partwise/>',
        {},
        async () => {},
        undefined,
        undefined,
        { onSample: (sample) => samples.push(sample) },
      ),
    ).resolves.toBe(MAX_SCORE_EXPORT_PAGES);
    expect(client.renderPage).toHaveBeenCalledTimes(MAX_SCORE_EXPORT_PAGES);
    expect(samples.at(-1)).toMatchObject({ activeBytes: 0 });
    expect(Math.max(...samples.map((sample) => sample.activeBytes))).toBe(
      new TextEncoder().encode(svg).byteLength,
    );
  });

  it('fails before handing an SVG to its consumer when the page exceeds the memory budget', async () => {
    const consume = vi.fn();
    const client = {
      load: vi.fn(async () => 1),
      renderPage: vi.fn(async () => `<svg>${'x'.repeat(128)}</svg>`),
    };
    await expect(
      consumeScorePagesSnapshot(client, '<score-partwise/>', {}, consume, undefined, undefined, {
        budgetBytes: 16,
      }),
    ).rejects.toThrow(/working memory/);
    expect(consume).not.toHaveBeenCalled();
  });
});
