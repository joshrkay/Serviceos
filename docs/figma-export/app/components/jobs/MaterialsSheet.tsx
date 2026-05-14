import { useState } from 'react';
import { Search, Plus, Minus, Trash2, X, Check, Package } from 'lucide-react';
import { SheetOverlay } from './JobSheets';
import type { MaterialItem, ServiceType } from '../../data/mock-data';

const CATALOG: Record<ServiceType, Omit<MaterialItem, 'id' | 'qty'>[]> = {
  HVAC: [
    { name: '45/5 MFD Dual Run Capacitor',  partNumber: 'CAP-45-5-440V', unitCost: 28.50,  category: 'Part' },
    { name: 'Contactor 40A 24V Coil',        partNumber: 'CONT-2P-40A',   unitCost: 22.00,  category: 'Part' },
    { name: '1-Ton R-410A Refrigerant (lb)', partNumber: 'R410A-LB',      unitCost: 18.00,  category: 'Material' },
    { name: '16x25x1 MERV-8 Filter',         partNumber: 'FILT-16251',    unitCost: 9.50,   category: 'Part' },
    { name: 'Nest Learning Thermostat',       partNumber: 'NEST-GEN4',     unitCost: 199.00, category: 'Equipment' },
    { name: 'Drain Pan Treatment Tablets',   partNumber: 'DRAIN-TAB-12',  unitCost: 14.00,  category: 'Material' },
    { name: 'Coil Cleaning Foam (can)',       partNumber: 'COIL-CLN',      unitCost: 16.50,  category: 'Material' },
    { name: 'Service Labor (hour)',           partNumber: 'LABOR-HR',      unitCost: 95.00,  category: 'Labor' },
  ],
  Plumbing: [
    { name: '2\" Type L Copper Pipe (10ft)', partNumber: 'COP-2L-10',    unitCost: 44.00,  category: 'Material' },
    { name: '2\" 90° Copper Elbow',          partNumber: 'ELB-2-90',     unitCost: 8.75,   category: 'Part' },
    { name: 'Flux & Solder Kit',             partNumber: 'FLUX-KIT',     unitCost: 12.50,  category: 'Material' },
    { name: 'Wax Ring w/ Bolts',             partNumber: 'WAX-RING',     unitCost: 7.50,   category: 'Part' },
    { name: 'P-Trap 1.5\" ABS',             partNumber: 'PTRAP-15',     unitCost: 6.25,   category: 'Part' },
    { name: 'Drain Cleaning Chemical',       partNumber: 'DRAIN-CLN',    unitCost: 11.00,  category: 'Material' },
    { name: 'Toilet Flapper Valve',          partNumber: 'FLAP-STD',     unitCost: 5.50,   category: 'Part' },
    { name: 'Plumbing Labor (hour)',         partNumber: 'LABOR-HR',     unitCost: 110.00, category: 'Labor' },
  ],
  Painting: [
    { name: 'SW Emerald Interior Paint (gal)', partNumber: 'SW-EMR-INT',  unitCost: 58.00,  category: 'Material' },
    { name: 'SW Alabaster Exterior (gal)',      partNumber: 'SW-ALB-EXT',  unitCost: 62.50,  category: 'Material' },
    { name: 'Premium Primer (gal)',             partNumber: 'PRIM-GAL',    unitCost: 34.00,  category: 'Material' },
    { name: '9\" Roller Frame & Cover',        partNumber: 'ROLL-9',      unitCost: 8.50,   category: 'Equipment' },
    { name: 'Blue Painter\'s Tape 1.5\"',      partNumber: 'TAPE-15',     unitCost: 6.75,   category: 'Material' },
    { name: '10×12 Canvas Drop Cloth',         partNumber: 'DROP-1012',   unitCost: 18.00,  category: 'Equipment' },
    { name: '2.5\" Angled Sash Brush',         partNumber: 'BRUSH-25A',   unitCost: 12.00,  category: 'Equipment' },
    { name: 'Painting Labor (hour)',            partNumber: 'LABOR-HR',    unitCost: 75.00,  category: 'Labor' },
  ],
};

const CATEGORY_COLORS: Record<MaterialItem['category'], string> = {
  Part:      'bg-blue-100 text-blue-700',
  Material:  'bg-green-100 text-green-700',
  Labor:     'bg-violet-100 text-violet-700',
  Equipment: 'bg-amber-100 text-amber-700',
};

interface Props {
  serviceType: ServiceType;
  existing: MaterialItem[];
  onClose: (updated: MaterialItem[]) => void;
}

export function MaterialsSheet({ serviceType, existing, onClose }: Props) {
  const [items, setItems]       = useState<MaterialItem[]>(existing.map(e => ({ ...e })));
  const [search, setSearch]     = useState('');
  const [showCustom, setCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customCost, setCustomCost] = useState('');
  const [customQty,  setCustomQty]  = useState('1');

  const catalog = CATALOG[serviceType] ?? CATALOG.HVAC;
  const filtered = catalog.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.partNumber ?? '').toLowerCase().includes(search.toLowerCase())
  );

  function addFromCatalog(c: Omit<MaterialItem, 'id' | 'qty'>) {
    const existing = items.find(i => i.partNumber === c.partNumber && i.name === c.name);
    if (existing) {
      setItems(prev => prev.map(i => i.id === existing.id ? { ...i, qty: i.qty + 1 } : i));
    } else {
      setItems(prev => [...prev, { ...c, id: `m-${Date.now()}`, qty: 1 }]);
    }
  }

  function updateQty(id: string, delta: number) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, qty: Math.max(0, i.qty + delta) } : i)
      .filter(i => i.qty > 0));
  }

  function removeItem(id: string) {
    setItems(prev => prev.filter(i => i.id !== id));
  }

  function addCustomItem() {
    if (!customName.trim() || !customCost) return;
    setItems(prev => [...prev, {
      id: `custom-${Date.now()}`,
      name: customName.trim(),
      qty: parseInt(customQty) || 1,
      unitCost: parseFloat(customCost) || 0,
      category: 'Material',
    }]);
    setCustomName(''); setCustomCost(''); setCustomQty('1'); setCustom(false);
  }

  const total = items.reduce((s, i) => s + i.qty * i.unitCost, 0);

  return (
    <SheetOverlay onClose={() => onClose(items)} maxH="92vh">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Package size={16} className="text-amber-500" />
          <p className="text-sm text-slate-900">Materials & Parts</p>
        </div>
        <button onClick={() => onClose(items)} className="p-1.5 rounded-lg hover:bg-slate-100">
          <X size={16} className="text-slate-400" />
        </button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 mb-3">
        <Search size={14} className="text-slate-400 shrink-0" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search parts catalog…"
          className="flex-1 text-sm text-slate-700 placeholder-slate-400 outline-none bg-transparent"
        />
      </div>

      {/* Catalog */}
      <div className="mb-4">
        <p className="text-xs text-slate-400 mb-2">{serviceType} catalog</p>
        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1">
          {filtered.map((c, i) => {
            const inCart = items.find(it => it.name === c.name);
            return (
              <button
                key={i}
                onClick={() => addFromCatalog(c)}
                className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors ${
                  inCart ? 'bg-green-50 border border-green-200' : 'bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-slate-800 truncate">{c.name}</p>
                    <span className={`text-xs rounded-full px-1.5 py-0.5 shrink-0 ${CATEGORY_COLORS[c.category]}`}>
                      {c.category}
                    </span>
                  </div>
                  {c.partNumber && <p className="text-xs text-slate-400 mt-0.5">{c.partNumber}</p>}
                </div>
                <div className="text-right ml-2 shrink-0">
                  <p className="text-sm text-slate-700">${c.unitCost.toFixed(2)}</p>
                  {inCart && <span className="text-xs text-green-600">×{inCart.qty}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Current items */}
      {items.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-slate-400 mb-2">Added to job</p>
          <div className="flex flex-col gap-1.5">
            {items.map(item => (
              <div key={item.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 bg-white">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 truncate">{item.name}</p>
                  <p className="text-xs text-slate-400">${item.unitCost.toFixed(2)} each</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => updateQty(item.id, -1)} className="flex size-6 items-center justify-center rounded-full border border-slate-200 hover:bg-slate-100 transition-colors">
                    <Minus size={11} className="text-slate-600" />
                  </button>
                  <span className="w-5 text-center text-sm text-slate-700">{item.qty}</span>
                  <button onClick={() => updateQty(item.id, 1)} className="flex size-6 items-center justify-center rounded-full border border-slate-200 hover:bg-slate-100 transition-colors">
                    <Plus size={11} className="text-slate-600" />
                  </button>
                  <span className="w-14 text-right text-sm text-slate-700">${(item.qty * item.unitCost).toFixed(2)}</span>
                  <button onClick={() => removeItem(item.id)} className="ml-1 text-slate-300 hover:text-red-400 transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add custom */}
      {!showCustom ? (
        <button
          onClick={() => setCustom(true)}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 mb-4 transition-colors"
        >
          <Plus size={12} /> Add custom item
        </button>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 mb-4">
          <p className="text-xs text-slate-500 mb-2">Custom item</p>
          <div className="flex flex-col gap-2">
            <input
              value={customName}
              onChange={e => setCustomName(e.target.value)}
              placeholder="Item name"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder-slate-400 outline-none focus:border-blue-400"
            />
            <div className="flex gap-2">
              <input
                value={customCost}
                onChange={e => setCustomCost(e.target.value)}
                placeholder="Unit cost ($)"
                type="number"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder-slate-400 outline-none focus:border-blue-400"
              />
              <input
                value={customQty}
                onChange={e => setCustomQty(e.target.value)}
                placeholder="Qty"
                type="number"
                min="1"
                className="w-16 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder-slate-400 outline-none focus:border-blue-400"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={addCustomItem}
                disabled={!customName.trim() || !customCost}
                className="flex-1 rounded-lg bg-slate-900 text-white text-sm py-2 hover:bg-slate-700 transition-colors disabled:opacity-40"
              >
                Add
              </button>
              <button
                onClick={() => setCustom(false)}
                className="px-4 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Total + confirm */}
      <div className="rounded-xl bg-slate-900 text-white px-4 py-3.5 flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-400">{items.length} item{items.length !== 1 ? 's' : ''}</p>
          <p className="text-sm">Materials total</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-lg">${total.toFixed(2)}</p>
          <button
            onClick={() => onClose(items)}
            className="flex items-center gap-1.5 rounded-lg bg-white text-slate-900 px-3 py-2 text-sm hover:bg-slate-100 transition-colors"
          >
            <Check size={14} /> Save
          </button>
        </div>
      </div>
    </SheetOverlay>
  );
}
