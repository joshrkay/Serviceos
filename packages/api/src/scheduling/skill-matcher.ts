export interface SkillMatcher {
  requiredSkillsForJob(tenantId: string, jobId: string): Promise<string[]>;
  skillsForTechnician(tenantId: string, technicianId: string): Promise<string[]>;
}

export class StubSkillMatcher implements SkillMatcher {
  async requiredSkillsForJob(): Promise<string[]> { return []; }
  async skillsForTechnician(): Promise<string[]> { return []; }
}
