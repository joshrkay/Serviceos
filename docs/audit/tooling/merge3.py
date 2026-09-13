"""3-way merge of a conflicted path from the git index: apply ours' and theirs' edits vs base when their base ranges don't overlap.
Same-anchor pure insertions are unioned (ours first). Overlapping modifications are reported and the file is left unresolved."""
import subprocess,sys,difflib
F=sys.argv[1]
def stage(n): return subprocess.run(['git','show',f':{n}:{F}'],capture_output=True,text=True,check=True).stdout.split('\n')
base,ours,theirs=stage(1),stage(2),stage(3)
def ops(side):
    sm=difflib.SequenceMatcher(None,base,side,autojunk=False)
    return [(tag,i1,i2,side[j1:j2]) for tag,i1,i2,j1,j2 in sm.get_opcodes() if tag!='equal']
O,T=ops(ours),ops(theirs)
def overlap(a,b):
    # ranges [i1,i2); pure inserts have i1==i2
    (ta,a1,a2,_),(tb,b1,b2,_)=a,b
    if ta=='insert' and tb=='insert': return False  # union
    if ta=='insert': return b1<a1<b2
    if tb=='insert': return a1<b1<a2
    return a1<b2 and b1<a2
conf=[(a,b) for a in O for b in T if overlap(a,b)]
if conf:
    for a,b in conf: print('OVERLAP ours',a[0],a[1],a[2],'| theirs',b[0],b[1],b[2]); print('   ours:',a[3][0][:120] if a[3] else ''); print('   theirs:',b[3][0][:120] if b[3] else '')
    sys.exit(2)
edits=sorted([(i1,i2,0,tag,rep) for tag,i1,i2,rep in O]+[(i1,i2,1,tag,rep) for tag,i1,i2,rep in T])
out=[]; pos=0
for i1,i2,side,tag,rep in edits:
    out.extend(base[pos:i1]); out.extend(rep); pos=max(pos,i2)
out.extend(base[pos:])
open(F,'w').write('\n'.join(out)); print(f'{F}: merged {len(O)} ours + {len(T)} theirs edits; base {len(base)} -> {len(out)} lines')
