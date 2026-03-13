import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ClarificationCard, validateClarificationResponse } from './ClarificationCard';
import { ClarificationRequest } from '../../types/conversation';

describe('P3-005 — Clarification rendering and response flow', () => {
  const textClarification: ClarificationRequest = {
    id: 'clar-1',
    question: 'What is the preferred appointment time?',
    taskId: 'task-1',
    resolved: false,
  };

  const optionClarification: ClarificationRequest = {
    id: 'clar-2',
    question: 'Which HVAC system type?',
    options: ['Central Air', 'Ductless Mini-Split', 'Heat Pump'],
    taskId: 'task-2',
    resolved: false,
  };

  const resolvedClarification: ClarificationRequest = {
    id: 'clar-3',
    question: 'What is the budget?',
    taskId: 'task-3',
    resolved: true,
    response: 'Around $5000',
  };

  it('happy path — renders clarification question and accepts text response', () => {
    const onRespond = vi.fn();
    render(<ClarificationCard clarification={textClarification} onRespond={onRespond} />);

    expect(screen.getByTestId('clarification-question')).toHaveTextContent(
      'What is the preferred appointment time?'
    );

    const input = screen.getByTestId('clarification-input');
    fireEvent.change(input, { target: { value: 'Morning, before 10 AM' } });
    fireEvent.click(screen.getByTestId('clarification-submit'));

    expect(onRespond).toHaveBeenCalledWith('clar-1', 'Morning, before 10 AM');
  });

  it('happy path — renders option buttons and selects option', () => {
    const onRespond = vi.fn();
    render(<ClarificationCard clarification={optionClarification} onRespond={onRespond} />);

    expect(screen.getByTestId('clarification-options')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('clarification-option-1'));

    expect(onRespond).toHaveBeenCalledWith('clar-2', 'Ductless Mini-Split');
  });

  it('happy path — renders resolved clarification', () => {
    const onRespond = vi.fn();
    render(<ClarificationCard clarification={resolvedClarification} onRespond={onRespond} />);

    expect(screen.getByTestId('clarification-card')).toHaveAttribute('data-resolved', 'true');
    expect(screen.getByTestId('clarification-response')).toHaveTextContent('Around $5000');
    expect(screen.queryByTestId('clarification-input')).not.toBeInTheDocument();
  });

  it('validation — empty response rejected', () => {
    const onRespond = vi.fn();
    render(<ClarificationCard clarification={textClarification} onRespond={onRespond} />);

    fireEvent.click(screen.getByTestId('clarification-submit'));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByTestId('clarification-error')).toHaveTextContent(
      'Response cannot be empty'
    );
  });

  it('validation — validateClarificationResponse checks whitespace', () => {
    expect(validateClarificationResponse('')).toBe('Response cannot be empty');
    expect(validateClarificationResponse('   ')).toBe('Response cannot be empty');
    expect(validateClarificationResponse('Valid')).toBeNull();
  });
});
