<script setup lang="ts">
/**
 * Inline transport glyphs as crisp vector icons, replacing the platform-emoji
 * glyphs that rendered inconsistently across systems. Every icon inherits
 * `currentColor`, so it picks up the host button's state colours (hover, active,
 * disabled) for free.
 */
export type TransportIconName =
  | 'to-start'
  | 'to-end'
  | 'rewind'
  | 'forward'
  | 'cycle'
  | 'stop'
  | 'play'
  | 'record'
  | 'chevron-down'
  | 'metronome'
  | 'settings';

defineProps<{ name: TransportIconName }>();
</script>

<template>
  <svg
    class="t-icon"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <!-- Go to start: a left wall with a triangle resting against it. -->
    <template v-if="name === 'to-start'">
      <rect x="6.4" y="5.5" width="2.4" height="13" rx="1" />
      <path d="M18.6 5.5 9.9 12 18.6 18.5 Z" />
    </template>

    <!-- Go to end: a triangle pointing into a right wall. -->
    <template v-else-if="name === 'to-end'">
      <path d="M5.4 5.5 14.1 12 5.4 18.5 Z" />
      <rect x="15.2" y="5.5" width="2.4" height="13" rx="1" />
    </template>

    <!-- Nudge back: a double triangle pointing left. -->
    <template v-else-if="name === 'rewind'">
      <path d="M11.5 5.5 4.5 12 11.5 18.5 Z" />
      <path d="M19.3 5.5 12.3 12 19.3 18.5 Z" />
    </template>

    <!-- Nudge forward: a double triangle pointing right. -->
    <template v-else-if="name === 'forward'">
      <path d="M4.7 5.5 11.7 12 4.7 18.5 Z" />
      <path d="M12.5 5.5 19.5 12 12.5 18.5 Z" />
    </template>

    <!-- Cycle: a repeat loop with arrowheads top-right and bottom-left. -->
    <path
      v-else-if="name === 'cycle'"
      d="M7 7h9.5v2.4L21 5.7 16.5 2v2.4H4.6v6.2H7V7Zm10 10H7.5v-2.4L3 18.3 7.5 22v-2.4h11.9v-6.2H17V17Z"
    />

    <!-- Stop: a rounded square. -->
    <rect v-else-if="name === 'stop'" x="6.5" y="6.5" width="11" height="11" rx="2" />

    <!-- Play: a right-pointing triangle. -->
    <path v-else-if="name === 'play'" d="M8 5 19.5 12 8 19 Z" />

    <!-- Record: a solid disc. -->
    <circle v-else-if="name === 'record'" cx="12" cy="12" r="5.6" />

    <!-- Settings disclosure: a downward chevron. -->
    <path
      v-else-if="name === 'chevron-down'"
      d="M6.5 9.5 12 15 17.5 9.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />

    <!-- Metronome: a trapezoid body with a diagonal pendulum rod. -->
    <g
      v-else-if="name === 'metronome'"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9.4 4.5 14.6 4.5 17.6 19.5 6.4 19.5 Z" />
      <path d="M11.6 18 15 7.5" />
    </g>

    <!-- Settings: a cogwheel with a hollow centre. -->
    <path
      v-else-if="name === 'settings'"
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M10.6 2.5h2.8l.5 2.4a7 7 0 0 1 1.7 1l2.3-.9 1.4 2.4-1.8 1.6a7 7 0 0 1 0 2l1.8 1.6-1.4 2.4-2.3-.9a7 7 0 0 1-1.7 1l-.5 2.4h-2.8l-.5-2.4a7 7 0 0 1-1.7-1l-2.3.9-1.4-2.4 1.8-1.6a7 7 0 0 1 0-2L4.2 7.4l1.4-2.4 2.3.9a7 7 0 0 1 1.7-1l.5-2.4ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
    />
  </svg>
</template>

<style scoped>
.t-icon {
  display: block;
  width: 15px;
  height: 15px;
}
</style>
