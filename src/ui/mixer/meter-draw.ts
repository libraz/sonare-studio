/**
 * Canvas drawing shared by the transport and per-strip level meters.
 *
 * Both meters paint the same zone-coloured RMS fill, peak cap and hold marker;
 * they differ only in the vertical extent a bar occupies.
 */
import { colorWithAlpha, METER_ZONE_ALPHA, TOKENS } from '@/ui/theme/tokens';
import { type MeterChannelModel, meterFraction } from './meter-model';

/** Levels below this many dB are drawn in the green zone. */
export const GREEN_BELOW_DB = -12;

/** Levels below this many dB (and above the green zone) are drawn yellow. */
export const YELLOW_BELOW_DB = -6;

/** Dimmed scale backdrop, derived from the ramp so every meter matches. */
const ZONE_GREEN = colorWithAlpha(TOKENS.meterGreen, METER_ZONE_ALPHA);
const ZONE_YELLOW = colorWithAlpha(TOKENS.meterYellow, METER_ZONE_ALPHA);
const ZONE_RED = colorWithAlpha(TOKENS.meterRed, METER_ZONE_ALPHA);

/**
 * Draws one vertical meter bar: zone backdrop, RMS fill, peak cap and hold marker.
 *
 * @param ctx Canvas context, already scaled to CSS px.
 * @param model Displayed channel state.
 * @param x Left edge of the bar.
 * @param barW Bar width.
 * @param top Top edge of the bar area (0 dB).
 * @param height Height of the bar area (floor at `top + height`).
 * @param minDb Bottom of the visible dB range.
 */
export function drawMeterBar(
  ctx: CanvasRenderingContext2D,
  model: MeterChannelModel,
  x: number,
  barW: number,
  top: number,
  height: number,
  minDb: number,
): void {
  const bottom = top + height;
  const dbToY = (db: number): number => top + (1 - meterFraction(db, minDb)) * height;
  const yYellow = dbToY(GREEN_BELOW_DB);
  const yRed = dbToY(YELLOW_BELOW_DB);
  ctx.fillStyle = ZONE_GREEN;
  ctx.fillRect(x, yYellow, barW, bottom - yYellow);
  ctx.fillStyle = ZONE_YELLOW;
  ctx.fillRect(x, yRed, barW, yYellow - yRed);
  ctx.fillStyle = ZONE_RED;
  ctx.fillRect(x, top, barW, yRed - top);
  // RMS fill, clipped per zone.
  const yRms = dbToY(model.rmsDb);
  const fillZone = (color: string, zoneTop: number, zoneBottom: number): void => {
    const fillTop = Math.max(yRms, zoneTop);
    if (fillTop < zoneBottom) {
      ctx.fillStyle = color;
      ctx.fillRect(x, fillTop, barW, zoneBottom - fillTop);
    }
  };
  fillZone(TOKENS.meterGreen, yYellow, bottom);
  fillZone(TOKENS.meterYellow, yRed, yYellow);
  fillZone(TOKENS.meterRed, top, yRed);
  // Peak cap, coloured by its own zone.
  if (model.peakDb > minDb) {
    ctx.fillStyle =
      model.peakDb >= YELLOW_BELOW_DB
        ? TOKENS.meterPeakHot
        : model.peakDb >= GREEN_BELOW_DB
          ? TOKENS.meterPeakWarm
          : TOKENS.meterPeakCool;
    ctx.fillRect(x, Math.max(top, dbToY(model.peakDb) - 1), barW, 1.5);
  }
  if (model.holdDb > minDb) {
    ctx.fillStyle = TOKENS.meterHold;
    ctx.fillRect(x, Math.max(top, dbToY(model.holdDb) - 0.5), barW, 1);
  }
}
