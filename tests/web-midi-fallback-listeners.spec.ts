import { describe, expect, it, vi } from 'vitest';
import { listenMidiMessages, listenStateChange } from '@/lib/web-midi';

type Handler = ((event: number) => void) | null;

describe('web-midi property-handler fallback', () => {
  it('detaching the first of two message listeners keeps the second', () => {
    const input: { onmidimessage: Handler } = { onmidimessage: null };
    const a = vi.fn();
    const b = vi.fn();
    const stopA = listenMidiMessages(input, a);
    const stopB = listenMidiMessages(input, b);

    stopA();
    input.onmidimessage?.(1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(1);

    stopB();
    expect(input.onmidimessage).toBeNull();
  });

  it('does not resurrect a detached listener when the later one detaches', () => {
    const input: { onmidimessage: Handler } = { onmidimessage: null };
    const a = vi.fn();
    const b = vi.fn();
    const stopA = listenMidiMessages(input, a);
    const stopB = listenMidiMessages(input, b);

    stopA();
    stopB();
    input.onmidimessage?.(1);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('restores a pre-existing handler once the last listener detaches', () => {
    const original = vi.fn();
    const input: { onmidimessage: Handler } = { onmidimessage: original };
    const a = vi.fn();
    const stop = listenMidiMessages(input, a);

    input.onmidimessage?.(2);
    expect(original).toHaveBeenCalledWith(2);
    expect(a).toHaveBeenCalledWith(2);

    stop();
    expect(input.onmidimessage).toBe(original);
  });

  it('applies the same semantics to state-change listeners', () => {
    const access: { onstatechange: ((event: unknown) => void) | null } = { onstatechange: null };
    const a = vi.fn();
    const b = vi.fn();
    const stopA = listenStateChange(access, a);
    const stopB = listenStateChange(access, b);

    stopA();
    access.onstatechange?.('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith('x');
    stopB();
    expect(access.onstatechange).toBeNull();
  });
});
