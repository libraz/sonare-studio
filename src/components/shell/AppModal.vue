<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { wrapTabFocus } from '@/ui/settings/focus-trap';

/**
 * Reusable frosted-glass modal shell. Owns the overlay, entrance/exit
 * transition, focus trap, Escape-to-dismiss and focus restoration; callers
 * supply only the content through the `title`, default and `actions` slots.
 *
 * This is the single base every dialog in the app builds on, so the modal
 * material (blur, hairline, shadow, motion) is defined in exactly one place.
 */

const props = withDefaults(
  defineProps<{
    /** Whether the modal is visible. */
    open: boolean;
    /** Accessible label when no visible title is rendered. */
    ariaLabel?: string;
    /** Width preset. */
    size?: 'sm' | 'md' | 'lg';
    /** Dismiss when the backdrop is clicked. */
    closeOnOverlay?: boolean;
    /** Dismiss on the Escape key. */
    dismissable?: boolean;
  }>(),
  { size: 'md', closeOnOverlay: true, dismissable: true },
);

const emit = defineEmits<{
  /** The user requested dismissal (overlay click, Escape, or close affordance). */
  close: [];
}>();

const dialogRef = ref<HTMLElement | null>(null);

/** Element focused before the modal opened, restored on close. */
let previousFocus: HTMLElement | null = null;

watch(
  () => props.open,
  (open, wasOpen) => {
    if (open && !wasOpen) {
      const active = document.activeElement;
      previousFocus = active instanceof HTMLElement ? active : null;
      void nextTick(() => dialogRef.value?.focus());
    } else if (!open && wasOpen) {
      if (previousFocus?.isConnected) previousFocus.focus();
      previousFocus = null;
    }
  },
);

function onOverlayClick(): void {
  if (props.closeOnOverlay) emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (dialogRef.value !== null && wrapTabFocus(event, dialogRef.value)) return;
  if (event.key === 'Escape' && props.dismissable) {
    event.preventDefault();
    emit('close');
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="props.open" class="modal-scrim" @click.self="onOverlayClick">
        <div
          ref="dialogRef"
          class="modal-card"
          :class="`is-${props.size}`"
          role="dialog"
          aria-modal="true"
          :aria-label="props.ariaLabel"
          tabindex="-1"
          @keydown="onKeydown"
        >
          <header v-if="$slots.title" class="modal-head">
            <h2 class="modal-heading"><slot name="title" /></h2>
            <button
              v-if="props.dismissable"
              type="button"
              class="modal-close"
              aria-label="Close"
              @click="emit('close')"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>
          <div class="modal-body"><slot /></div>
          <footer v-if="$slots.actions" class="modal-foot">
            <slot name="actions" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-scrim {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgba(17, 24, 39, 0.28);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

.modal-card {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 3rem);
  width: min(34rem, 100%);
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur-strong);
  backdrop-filter: var(--glass-blur-strong);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--glass-hairline), var(--shadow-modal);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.modal-card.is-sm {
  width: min(24rem, 100%);
}

.modal-card.is-lg {
  width: min(52rem, 100%);
}

.modal-card:focus {
  outline: none;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-5) var(--sp-6) var(--sp-3);
}

.modal-heading {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  letter-spacing: -0.01em;
}

.modal-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border-radius: var(--radius-full);
  background: var(--surface-4);
  border: 1px solid transparent;
  box-shadow: none;
  color: var(--text-3);
}

.modal-close:hover:not(:disabled) {
  background: var(--surface-4);
  color: var(--text-1);
}

.modal-body {
  padding: 0 var(--sp-6) var(--sp-5);
  overflow: auto;
  min-height: 0;
}

.modal-body:first-child {
  padding-top: var(--sp-6);
}

.modal-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-6) var(--sp-5);
  border-top: 1px solid var(--border-subtle);
}

/* Entrance / exit — gentle iOS scale-and-fade with spring on the way in. */
.modal-enter-active {
  transition: opacity var(--dur-2) var(--ease-out);
}
.modal-leave-active {
  transition: opacity var(--dur-2) var(--ease-out);
}
.modal-enter-active .modal-card {
  transition: transform var(--dur-3) var(--ease-spring),
    opacity var(--dur-2) var(--ease-out);
}
.modal-leave-active .modal-card {
  transition: transform var(--dur-2) var(--ease-out),
    opacity var(--dur-2) var(--ease-out);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-card {
  opacity: 0;
  transform: scale(0.94) translateY(8px);
}
.modal-leave-to .modal-card {
  opacity: 0;
  transform: scale(0.97);
}
</style>
