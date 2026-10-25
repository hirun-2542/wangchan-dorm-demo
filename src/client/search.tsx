import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface SearchValue {
  query: string;
  setQuery: (query: string) => void;
}

const SearchContext = createContext<SearchValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");

  const value = useMemo<SearchValue>(() => ({ query, setQuery }), [query]);

  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export function useSearch(): SearchValue {
  const value = useContext(SearchContext);

  if (value === null) {
    throw new Error("useSearch ต้องเรียกภายใน SearchProvider");
  }

  return value;
}
