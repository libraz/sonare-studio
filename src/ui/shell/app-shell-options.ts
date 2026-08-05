import type { TourStep } from '@/components/onboarding/tour-steps';

export const COUNT_IN_CHOICES = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1 bar' },
  { value: 2, label: '2 bars' },
  { value: 3, label: '3 bars' },
  { value: 4, label: '4 bars' },
] as const;

export const SNAP_CHOICES = [
  { value: 'bar', label: 'Bar' },
  { value: 1, label: '1/1' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1/4' },
  { value: 8 / 3, label: '1/4.' },
  { value: 8, label: '1/8' },
  { value: 12, label: '1/8T' },
  { value: 16 / 3, label: '1/8.' },
  { value: 16, label: '1/16' },
  { value: 24, label: '1/16T' },
  { value: 32 / 3, label: '1/16.' },
  { value: 32, label: '1/32' },
] as const;

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'transport',
    target: '.transport-bar',
    title: 'Transport bar',
    body: 'Play, stop, record, cycle, tempo, locators and the playhead position live in this bottom dock. Pressing Play boots the audio engine automatically.',
    placement: 'top',
  },
  {
    id: 'arrange',
    target: '.arrange-zone',
    title: 'Arrangement',
    body: 'Tracks and clips on the timeline. Double-click an empty lane to create a clip.',
  },
  {
    id: 'dock',
    target: '.dock-tabs',
    title: 'Editor dock',
    body: 'Switch between the piano roll, mixer, mastering, step sequencer and more.',
    placement: 'top',
  },
  {
    id: 'roll',
    target: '.piano-roll-host',
    title: 'Piano roll',
    body: 'Double-click to create notes, drag to move or resize them. Every edit is undoable.',
    placement: 'top',
  },
  {
    id: 'score',
    target: '.dock-tab-score',
    title: 'Score view',
    body: 'Engraves the active clip as notation - display-only, your MIDI never changes.',
    placement: 'top',
  },
  {
    id: 'menu',
    target: '.app-menubar:not(.app-menubar--end)',
    title: 'Project menu',
    body: 'New, open, save, audio import and all export options.',
  },
];
