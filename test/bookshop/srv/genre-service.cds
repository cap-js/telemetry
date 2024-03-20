using { sap.capire.bookshop as my } from '../db/schema';

service GenreService @(requires:'admin') {
  @odata.draft.enabled
  entity Genres as projection on my.Genres;
}
