/**
 * Screen positions of timeline content, read from the mounted canvases so a
 * scenario can click what it means to rather than guessing pixels.
 */

/**
 * Viewport point of a piano-roll note, or the given pitch at its middle.
 *
 * @param page The page under test.
 * @param note Note whose start and duration locate the point.
 * @param pitch Row to aim at; defaults to the note's own pitch.
 * @returns Viewport coordinates inside the note grid.
 */
export async function notePoint(page, note, pitch = note.pitch) {
  return page.evaluate(
    ({ note: target, pitch: targetPitch }) => {
      const grid = document.querySelector('.note-grid');
      const props = grid?.__vueParentComponent?.props;
      if (!grid || !props?.range) throw new Error('piano-roll range is unavailable');
      const rect = grid.getBoundingClientRect();
      const localX = props.range.ppqToX(target.startPpq + target.durationPpq / 2);
      const localY = props.range.pitchToY(targetPitch) + props.range.rowHeight / 2;
      if (localY < 4 || localY > rect.height - 4) {
        throw new Error(`pitch ${targetPitch} is outside the visible piano roll`);
      }
      return {
        x: rect.left + Math.max(4, Math.min(rect.width - 4, localX)),
        y: rect.top + localY,
      };
    },
    { note, pitch },
  );
}

/**
 * Viewport point inside a track's arrangement lane at a timeline position,
 * scrolling the lane into view first.
 *
 * @param page The page under test.
 * @param trackId Track owning the lane.
 * @param ppq Timeline position.
 * @returns Viewport coordinates over the lane.
 */
export async function arrangementPoint(page, trackId, ppq) {
  const read = () =>
    page.evaluate(
      ({ trackId, ppq }) => {
        const canvas = document.querySelector('.arrangement-canvas');
        const props = canvas?.__vueParentComponent?.props;
        if (!canvas || !props?.range || !props.tracks || !props.rowLayout) return null;
        const index = props.tracks.findIndex((track) => track.id === trackId);
        if (index < 0) return null;
        const rect = canvas.getBoundingClientRect();
        const rulerHeight = 28;
        const localY =
          rulerHeight + props.rowLayout.rowTop(index) - props.scrollY + props.laneHeight / 2;
        return {
          x: rect.left + props.range.ppqToX(ppq),
          y: rect.top + localY,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
        };
      },
      { trackId, ppq },
    );
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const point = await read();
    if (!point) throw new Error(`arrangement lane missing for track ${trackId}`);
    if (point.y >= point.top + 32 && point.y <= point.bottom - 2) return { x: point.x, y: point.y };
    await page.mouse.move(point.left + Math.min(160, point.width / 2), point.top + 120);
    await page.mouse.wheel(0, (point.y > point.bottom ? 1 : -1) * 280);
    await page.waitForTimeout(80);
  }
  throw new Error(`arrangement lane for track ${trackId} never scrolled into view`);
}
