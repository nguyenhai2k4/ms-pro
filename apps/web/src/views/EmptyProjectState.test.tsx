import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyProjectState } from './EmptyProjectState.jsx';

describe('EmptyProjectState (FR-PRJ-07, UC-1)', () => {
  it('offers the next action rather than a blank screen', () => {
    render(<EmptyProjectState projectName="Warehouse build" canEdit onAddFirstTask={() => {}} />);
    expect(screen.getByRole('heading', { name: /Warehouse build has no tasks yet/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add the first task/ })).toBeTruthy();
  });

  it('invokes the primary action', () => {
    const onAddFirstTask = vi.fn();
    render(
      <EmptyProjectState projectName="Warehouse build" canEdit onAddFirstTask={onAddFirstTask} />,
    );
    screen.getByRole('button', { name: /Add the first task/ }).click();
    expect(onAddFirstTask).toHaveBeenCalledOnce();
  });

  it('says import is unavailable rather than offering a button that fails', () => {
    render(<EmptyProjectState projectName="Warehouse build" canEdit onAddFirstTask={() => {}} />);
    const importButton = screen.getByRole('button', { name: /Import from CSV or XLSX/ });
    expect(importButton.hasAttribute('disabled')).toBe(true);
    expect(importButton.textContent).toContain('available later');
  });

  it('FR-ACL: a read-only role is offered no edit affordance', () => {
    render(
      <EmptyProjectState projectName="Warehouse build" canEdit={false} onAddFirstTask={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: /Add the first task/ })).toBeNull();
    // Hiding the button is not access control (invariant 3) — the server refusal is tested in
    // apps/api. This only asserts the UI does not dangle an action the caller cannot perform.
    expect(screen.getByText(/read-only access/)).toBeTruthy();
  });
});
