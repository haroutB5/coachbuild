import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = readFileSync(new URL('../../desktop/src/CoachBuild.Desktop/Web/UggSkillOrderReader.cs', import.meta.url), 'utf8');
const template = source.match(/public static string Script[\s\S]*?=> """([\s\S]*?)"""/)[1];
const html = readFileSync(new URL('./ugg-jhin-adc.html', import.meta.url), 'utf8');
const start = html.indexOf('window.__SSR_DATA__ = ');
const end = html.indexOf('</script>', start);
const textContent = html.slice(start, end);
function run(id, lane, text = textContent) {
  return vm.runInNewContext(template.replaceAll('__CHAMP__', String(id)).replaceAll('__LANE__', JSON.stringify(lane)), {
    document: { getElementById: () => ({ textContent: text }) },
  });
}
const path = run(202, 'adc').path;
assert.equal(path.matches, 75819);
assert.equal(Array.from(path.slots).join(''), 'QWQEQ RQWQW RWWEE REE'.replaceAll(' ', ''));
assert.equal(run(106, 'adc'), null, 'must not read a different champion');
assert.equal(run(202, 'missing').path, null, 'must not substitute another lane');
assert.equal(run(202, 'adc', 'challenge shell'), null);
console.log('Skill-order source checks passed: real Jhin recommended build, champion/lane isolation, missing source.');
