import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PY_MAIN = path.resolve(REPO_ROOT, 'service-os-agent/main.py');
const PY_STATE = path.resolve(REPO_ROOT, 'service-os-agent/agent/state.py');

describe('Python agent contract parity with TS gateway', () => {
  it('process request requires tenant/auth/transcript contract fields', async () => {
    const src = await fs.readFile(PY_MAIN, 'utf8');
    expect(src).toMatch(/class ProcessRequest\(BaseModel\):/);
    expect(src).toMatch(/tenant_id: str/);
    expect(src).toMatch(/auth_token: str/);
    expect(src).toMatch(/transcript: str/);
    expect(src).toMatch(/input_method: str = "text"/);
  });

  it('process response remains proposal-shaped and approval-gated upstream', async () => {
    const src = await fs.readFile(PY_MAIN, 'utf8');
    expect(src).toMatch(/proposal = result\.get\("proposal"\)/);
    expect(src).toMatch(/return proposal/);
  });

  it('proposal fields are typed in Python state contract', async () => {
    const src = await fs.readFile(PY_STATE, 'utf8');
    for (const key of [
      'type: str',
      'confidence: float',
      'confidence_level: Literal["high", "medium", "low"]',
      'customer: CustomerMatch',
      'clarification_question: Optional[str]',
      'confirmation_message: str',
    ]) {
      expect(src).toContain(key);
    }
  });
});
