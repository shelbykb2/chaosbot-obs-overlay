import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
export default defineConfig({root:fileURLToPath(new URL('./editor/',import.meta.url)),base:'./',publicDir:false,
  build:{outDir:fileURLToPath(new URL('../data/site/editor/',import.meta.url)),emptyOutDir:true,assetsDir:'assets',target:'chrome103',cssTarget:'chrome103',modulePreload:{polyfill:false}}});
