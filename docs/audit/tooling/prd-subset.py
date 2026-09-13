import subprocess,collections,sys
def stage(n): return subprocess.run(['git','show',f':{n}:docs/PRD-v5-as-built.md'],capture_output=True,text=True).stdout.splitlines()
b,o,t=stage(1),stage(2),stage(3)
def added(new, old):
    c=collections.Counter(old); out=[]
    for l in new:
        if c[l]>0: c[l]-=1
        else: out.append(l)
    return out
t_add=added(t,b); oc=collections.Counter(o); missing=[l for l in t_add if oc[l]==0]
print(f"theirs adds {len(t_add)} lines vs base; {len(missing)} not in ours")
for l in missing[:5]: print("  MISSING:", l[:240])
sys.exit(0 if not missing else 1)
