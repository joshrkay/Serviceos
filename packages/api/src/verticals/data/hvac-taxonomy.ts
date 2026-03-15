import { ServiceCategory } from '../service-taxonomy';

export const hvacCategories: ServiceCategory[] = [
  { id: 'hvac-diagnostic', name: 'Diagnostic', description: 'System evaluation, troubleshooting, and diagnostic services.', tags: ['diagnostic', 'troubleshoot', 'evaluation'], sortOrder: 1 },
  { id: 'hvac-repair', name: 'Repair', description: 'Repair and restoration of HVAC components and systems.', tags: ['repair', 'fix', 'restore'], sortOrder: 2 },
  { id: 'hvac-repair-electrical', name: 'Electrical Repair', parentId: 'hvac-repair', description: 'Repair of electrical components including capacitors, contactors, and wiring.', tags: ['electrical', 'capacitor', 'contactor', 'wiring'], sortOrder: 1 },
  { id: 'hvac-repair-refrigerant', name: 'Refrigerant Repair', parentId: 'hvac-repair', description: 'Refrigerant leak detection, repair, and recharge services.', tags: ['refrigerant', 'leak', 'recharge', 'freon'], sortOrder: 2 },
  { id: 'hvac-repair-mechanical', name: 'Mechanical Repair', parentId: 'hvac-repair', description: 'Repair of mechanical components including motors, fans, and compressors.', tags: ['motor', 'fan', 'compressor', 'mechanical'], sortOrder: 3 },
  { id: 'hvac-maintenance', name: 'Maintenance', description: 'Preventive maintenance, tune-ups, and system inspections.', tags: ['maintenance', 'tune-up', 'inspection', 'preventive'], sortOrder: 3 },
  { id: 'hvac-maintenance-seasonal', name: 'Seasonal Tune-Up', parentId: 'hvac-maintenance', description: 'Seasonal preventive maintenance including inspections, cleaning, and adjustments.', tags: ['seasonal', 'tune-up', 'spring', 'fall'], sortOrder: 1 },
  { id: 'hvac-maintenance-filter', name: 'Filter Service', parentId: 'hvac-maintenance', description: 'Air filter replacement and filtration system maintenance.', tags: ['filter', 'air-quality'], sortOrder: 2 },
  { id: 'hvac-install', name: 'Installation', description: 'New system installation and equipment setup.', tags: ['install', 'new', 'setup'], sortOrder: 4 },
  { id: 'hvac-install-ac', name: 'AC Installation', parentId: 'hvac-install', description: 'Installation of new air conditioning systems and components.', tags: ['ac', 'air-conditioning', 'cooling'], sortOrder: 1 },
  { id: 'hvac-install-heating', name: 'Heating Installation', parentId: 'hvac-install', description: 'Installation of new heating systems including furnaces and heat pumps.', tags: ['heating', 'furnace', 'heat-pump'], sortOrder: 2 },
  { id: 'hvac-install-ductwork', name: 'Ductwork Installation', parentId: 'hvac-install', description: 'New ductwork design, fabrication, and installation.', tags: ['ductwork', 'ducts'], sortOrder: 3 },
  { id: 'hvac-replacement', name: 'Replacement', description: 'Full system or major component replacement.', tags: ['replacement', 'upgrade', 'swap'], sortOrder: 5 },
  { id: 'hvac-emergency', name: 'Emergency Service', description: 'After-hours and emergency HVAC service calls.', tags: ['emergency', 'after-hours', 'urgent'], sortOrder: 6 },
  { id: 'hvac-iaq', name: 'Indoor Air Quality', description: 'Air quality assessment, purification, and humidity control services.', tags: ['iaq', 'air-quality', 'purifier', 'humidifier', 'dehumidifier'], sortOrder: 7 },
];
