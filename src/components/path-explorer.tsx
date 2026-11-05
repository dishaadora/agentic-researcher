"use client";

import { useEffect, useState, type ReactNode } from "react";

export type PathRow = { id: string; name: string; whenToUse: string; rating: ReactNode; hours: string; wait: string };

/**
 * The comparison table doubles as the route picker. The server renders every panel, and this
 * only toggles them. The selection lives in the URL hash, so a shared link opens the same route.
 */
export function PathExplorer({ rows, panels }: { rows: PathRow[]; panels: Record<string, ReactNode> }) {
  const [selected, setSelected] = useState(rows[0]?.id ?? "");

  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.replace(/^#path-/, "");
      if (rows.some((row) => row.id === id)) setSelected(id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [rows]);

  const choose = (id: string) => {
    setSelected(id);
    window.history.replaceState(null, "", `#path-${id}`);
  };

  return (
    <>
      <div className="table-scroll">
        <table className="paths">
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col">Difficulty</th>
              <th scope="col">Hands-on time</th>
              <th scope="col">Approval wait</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.id === selected ? "selected" : undefined}>
                <th scope="row">
                  <button type="button" className="path-pick" aria-pressed={row.id === selected} onClick={() => choose(row.id)}>
                    {row.name}
                  </button>
                  <span className="small muted path-when">{row.whenToUse}</span>
                </th>
                <td>{row.rating}</td>
                <td>{row.hours}</td>
                <td>{row.wait}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.map((row) => (
        <div key={row.id} hidden={row.id !== selected}>{panels[row.id]}</div>
      ))}
    </>
  );
}
