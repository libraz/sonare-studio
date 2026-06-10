<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ensureWasm } from '@/lib/wasm';

const version = ref('…');
const isolated = ref(globalThis.crossOriginIsolated === true);

onMounted(async () => {
  const wasm = await ensureWasm();
  version.value = wasm.version();
});
</script>

<template>
  <main style="font-family: system-ui; padding: 2rem">
    <h1>sonare studio</h1>
    <p>libsonare: <strong>{{ version }}</strong></p>
    <p>crossOriginIsolated: <strong>{{ isolated }}</strong> (SAB {{ isolated ? '有効' : '無効' }})</p>
  </main>
</template>
