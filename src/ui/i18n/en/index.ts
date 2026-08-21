/**
 * English message tree for the application UI.
 *
 * The tree is assembled from one module per area so a feature touches only its
 * own file; the shape is held identical across locales by the message parity
 * test, which compares the assembled trees rather than these parts.
 */
import { dialogs } from './dialogs';
import { harmony } from './harmony';
import { settings } from './settings';
import { shellArrangement } from './shell-arrangement';
import { shellEditors } from './shell-editors';
import { shellFrame } from './shell-frame';
import { shellMixing } from './shell-mixing';
import { shellSample } from './shell-sample';
import { shellScore } from './shell-score';
import { shortcuts } from './shortcuts';
import { theory } from './theory';

export const en = {
  settings,
  shell: {
    ...shellFrame,
    ...shellArrangement,
    ...shellEditors,
    ...shellMixing,
    ...shellSample,
    ...shellScore,
  },
  harmony,
  dialogs,
  shortcuts,
  theory,
} as const;
