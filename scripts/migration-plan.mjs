// Generates a reviewable additive SQL plan against a schema-only local snapshot.
// This script has no network or production-write capability.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {adapt} from '../backend/test/helpers/school-fixture.mjs';
import {ensureSchoolSchema} from '../backend/src/school-schema.js';
import {ensureCommerceSchema} from '../backend/src/commerce.js';
import {ensureLearningSchema} from '../backend/src/learning.js';
const args=process.argv.slice(2);const option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const input=option('--schema','database/baseline-2026-09-23.sql'),out=option('--out','work/migration-plan.sql');
const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(input,'utf8'));
const quote=v=>v===null?'NULL':typeof v==='number'?String(v):"'"+String(v).replaceAll("'","''")+"'";
const statements=[];const DB=adapt(sqlite,(sql,values)=>{let i=0;statements.push(sql.replace(/\?/g,()=>quote(values[i++]))+';');});
await ensureSchoolSchema(DB);const core=statements.splice(0);await ensureCommerceSchema(DB);const commerce=statements.splice(0);await ensureLearningSchema(DB);const learning=statements.splice(0);
if(sqlite.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Migration violates foreign keys');
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,['-- Generated from '+input+'; review before applying.','-- No data deletion. Apply once using migration tracking.',...core,...commerce,...learning].join('\n\n')+'\n');
if(args.includes('--write-core'))writeFileSync('database/migrations/006_school_core.sql',['-- Additive upgrade from baseline-2026-09-23.sql. Apply once using D1 migrations.',...core].join('\n\n')+'\n');
console.log(`Verified ${core.length+commerce.length+learning.length} statements against ${input}; plan: ${out}`);sqlite.close();
