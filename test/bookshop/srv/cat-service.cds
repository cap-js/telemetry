using {sap.capire.bookshop as my} from '../db/schema';

service CatalogService {

  /** For displaying lists of Books */
  @readonly
  entity ListOfBooks as
    projection on Books
    excluding {
      descr
    };

  /** For display in details pages */
  @readonly
  entity Books       as
    projection on my.Books {
      ID, title, stock
    };

  @requires: 'authenticated-user'
  action submitOrder(book : Books : ID, quantity : Integer) returns {
    stock                         : Integer
  };

  event OrderedBook : {
    book     : Books : ID;
    quantity : Integer;
    buyer    : String
  };
}
