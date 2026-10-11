import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('../test/',import.meta.url));
const files=readdirSync(directory).filter(name=>name.endsWith('.test.ts')).map(name=>fileURLToPath(new URL('../test/'+name,import.meta.url)));
if(!files.length)throw new Error('No frontend test files found.');
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
if(result.error)throw result.error;
process.exit(result.status??1);
