import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
export default defineConfig({
  root:fileURLToPath(new URL('./pages/',import.meta.url)), base:'/', publicDir:false,
  build:{outDir:fileURLToPath(new URL('../data/site/',import.meta.url)),emptyOutDir:true,assetsDir:'ui',target:'chrome103',cssTarget:'chrome103',modulePreload:{polyfill:false},
    rollupOptions:{input:Object.fromEntries(['scene','spotify'].map(p=>[p,fileURLToPath(new URL(`./pages/${p}/index.html`,import.meta.url))]))}},
});
