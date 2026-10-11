import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
const site=new URL('../../data/site/',import.meta.url);
mkdirSync(new URL('chaos/',site),{recursive:true});
copyFileSync(new URL('../../third_party/signalr.min.js',import.meta.url),new URL('chaos/signalr.min.js',site));
copyFileSync(new URL('../pages/index.html',import.meta.url),new URL('index.html',site));
copyFileSync(new URL('../pages/source.js',import.meta.url),new URL('source.js',site));
writeFileSync(new URL('PROVENANCE.txt',site),'Editor and widgets extracted from ChaosBot feature/overlay-describe, commit 21c5436.\n');
