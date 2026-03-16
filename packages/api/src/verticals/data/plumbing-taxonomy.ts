import { ServiceCategory } from '../service-taxonomy';

export const plumbingCategories: ServiceCategory[] = [
  { id: 'plumb-diagnostic', name: 'Diagnostic', description: 'Plumbing system evaluation, leak detection, and camera inspections.', tags: ['diagnostic', 'inspection', 'camera', 'leak-detection'], sortOrder: 1 },
  { id: 'plumb-repair', name: 'Repair', description: 'Repair and restoration of plumbing fixtures, pipes, and components.', tags: ['repair', 'fix', 'restore'], sortOrder: 2 },
  { id: 'plumb-repair-leak', name: 'Leak Repair', parentId: 'plumb-repair', description: 'Detection and repair of water leaks in pipes, fixtures, and fittings.', tags: ['leak', 'pipe-repair', 'fitting'], sortOrder: 1 },
  { id: 'plumb-repair-fixture', name: 'Fixture Repair', parentId: 'plumb-repair', description: 'Repair of faucets, toilets, showers, and other plumbing fixtures.', tags: ['faucet', 'toilet', 'shower', 'fixture'], sortOrder: 2 },
  { id: 'plumb-drain', name: 'Drain Services', description: 'Drain cleaning, clearing blockages, and drain line maintenance.', tags: ['drain', 'clog', 'blockage', 'cleaning'], sortOrder: 3 },
  { id: 'plumb-drain-cleaning', name: 'Drain Cleaning', parentId: 'plumb-drain', description: 'Standard drain cleaning and clog removal using snakes and augers.', tags: ['snake', 'auger', 'clog', 'cleaning'], sortOrder: 1 },
  { id: 'plumb-drain-hydrojetting', name: 'Hydro Jetting', parentId: 'plumb-drain', description: 'High-pressure water jetting for severe blockages and pipe cleaning.', tags: ['hydrojetting', 'high-pressure', 'jetting'], sortOrder: 2 },
  { id: 'plumb-waterheater', name: 'Water Heater', description: 'Water heater installation, repair, and maintenance services.', tags: ['water-heater', 'hot-water', 'tankless'], sortOrder: 4 },
  { id: 'plumb-waterheater-tank', name: 'Tank Water Heater', parentId: 'plumb-waterheater', description: 'Traditional tank water heater services.', tags: ['tank', 'storage', 'traditional'], sortOrder: 1 },
  { id: 'plumb-waterheater-tankless', name: 'Tankless Water Heater', parentId: 'plumb-waterheater', description: 'Tankless/on-demand water heater services.', tags: ['tankless', 'on-demand', 'instant'], sortOrder: 2 },
  { id: 'plumb-install', name: 'Installation', description: 'New plumbing fixture and appliance installation.', tags: ['install', 'new', 'setup'], sortOrder: 5 },
  { id: 'plumb-repiping', name: 'Repiping', description: 'Partial or whole-house repiping services.', tags: ['repipe', 'repiping', 'pipe-replacement'], sortOrder: 6 },
  { id: 'plumb-sewer', name: 'Sewer Services', description: 'Sewer line inspection, repair, and replacement.', tags: ['sewer', 'sewer-line', 'main-line'], sortOrder: 7 },
  { id: 'plumb-emergency', name: 'Emergency Service', description: 'After-hours and emergency plumbing service calls.', tags: ['emergency', 'after-hours', 'urgent', 'flood'], sortOrder: 8 },
  { id: 'plumb-backflow', name: 'Backflow Prevention', description: 'Backflow preventer installation, testing, and certification.', tags: ['backflow', 'rpz', 'prevention', 'testing'], sortOrder: 9 },
];
