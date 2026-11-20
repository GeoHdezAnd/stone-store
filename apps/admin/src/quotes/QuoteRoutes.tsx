import { Route, Routes } from 'react-router-dom';
import { QuoteDetailScreen } from './QuoteDetailScreen';
import { QuotesListScreen } from './QuotesListScreen';

/** `/quotes` (lista) y `/quotes/:quoteId` (detalle). Montar con `path="quotes/*"`. */
export function QuoteRoutes() {
  return (
    <Routes>
      <Route index element={<QuotesListScreen />} />
      <Route path=":quoteId" element={<QuoteDetailScreen />} />
    </Routes>
  );
}
