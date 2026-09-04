import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.goto('http://localhost:8123/index.html', { waitUntil: 'load' });
await p.waitForFunction(() => window.character != null, { timeout: 60000 });
await p.waitForTimeout(900);
console.log(JSON.stringify(await p.evaluate(() => {
  const c = window.character, THREE = window.THREE;
  let mesh=null; c.model.traverse(o=>{ if(!mesh&&o.isSkinnedMesh) mesh=o; });
  const a = c.anim; const clip='kick_roundhouse_left';
  for (const [,act] of a.actions) act.setEffectiveWeight(0);
  const act = a.actions.get(clip); act.enabled=true; act.setEffectiveWeight(1); act.paused=true;
  const v = new THREE.Vector3();
  const sample = (t) => {
    act.time = t; a.mixer.update(0);
    c.model.updateMatrixWorld(true); mesh.skeleton.update();
    const out=[];
    for (let i=0;i<mesh.geometry.getAttribute('position').count;i+=997){ mesh.getVertexPosition(i,v); out.push(v.x.toFixed(3)+','+v.y.toFixed(3)); }
    return out.join('|');
  };
  const d = a.duration(clip);
  const s0 = sample(0.0), s1 = sample(d*0.5);
  // also: do the BONE world positions differ between those two times?
  const bonePos = (t) => { act.time=t; a.mixer.update(0); c.model.updateMatrixWorld(true);
    const b2 = mesh.skeleton.bones.find(x=>/LeftFoot|LeftHand/.test(x.name));
    return b2.matrixWorld.elements.slice(12,15).map(n=>+n.toFixed(3)).join(','); };
  let n=0; c.model.traverse(o=>{ if(o.isSkinnedMesh) n++; });
  return {
    skinnedMeshCount: n,
    clip, dur:+d.toFixed(2),
    vertsDiffer: s0 !== s1,
    bonesAt0: bonePos(0), bonesAtMid: bonePos(d*0.5),
    skinningDefine: !!(mesh.material.defines && mesh.material.defines.USE_SKINNING),
    isSkinnedMesh: mesh.isSkinnedMesh,
    hasBoneTexture: !!mesh.skeleton.boneTexture,
  };
}), null, 1));
await b.close();
