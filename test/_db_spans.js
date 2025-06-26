module.exports = {
  SELECT: [
    {
      // name: "@cap-js/sqlite - prepare SELECT json_insert('{}','$.\"createdAt\"',createdAt,'$.\"…",
      name: s => s.match(/@cap-js\/\w+ - prepare /),
      attributes: {
        'code.function': 'prepare',
        'db.system': s => s === 'sqlite' || 'hanadb',
        'db.name': 'db',
        'db.connection_string': s => s === ':memory:' || s.match(/jdbc/),
        // 'db.statement':
        //   'SELECT json_insert(\'{}\',\'$."createdAt"\',createdAt,\'$."createdBy"\',createdBy,\'$."modifiedAt"\',modifiedAt,\'$."modifiedBy"\',modifiedBy,\'$."ID"\',ID,\'$."title"\',title,\'$."descr"\',descr,\'$."author_ID"\',author_ID,\'$."genre_ID"\',genre_ID,\'$."stock"\',stock,\'$."price"\',price,\'$."currency_code"\',currency_code) as _json_ FROM (SELECT "$B".createdAt,"$B".createdBy,"$B".modifiedAt,"$B".modifiedBy,"$B".ID,"$B".title,"$B".descr,"$B".author_ID,"$B".genre_ID,"$B".stock,"$B".price,"$B".currency_code FROM sap_capire_bookshop_Books as "$B" WHERE "$B".title is not ?)',
        'db.statement': s => s.match(/SELECT/),
        'db.operation': 'READ',
        'db.sql.table': 'sap.capire.bookshop.Books'
      }
    },
    {
      // name: "@cap-js/sqlite - stmt.all SELECT json_insert('{}','$.\"createdAt\"',createdAt,'$.…",
      name: s => s.match(/@cap-js\/\w+ - stmt\.all /) || s.match(/@cap-js\/\w+ - exec /),
      attributes: {
        'code.function': s => s === 'all' || 'exec',
        'db.system': s => s === 'sqlite' || 'hanadb',
        'db.name': 'db',
        'db.connection_string': s => s === ':memory:' || s.match(/jdbc/),
        // 'db.statement':
        //   'SELECT json_insert(\'{}\',\'$."createdAt"\',createdAt,\'$."createdBy"\',createdBy,\'$."modifiedAt"\',modifiedAt,\'$."modifiedBy"\',modifiedBy,\'$."ID"\',ID,\'$."title"\',title,\'$."descr"\',descr,\'$."author_ID"\',author_ID,\'$."genre_ID"\',genre_ID,\'$."stock"\',stock,\'$."price"\',price,\'$."currency_code"\',currency_code) as _json_ FROM (SELECT "$B".createdAt,"$B".createdBy,"$B".modifiedAt,"$B".modifiedBy,"$B".ID,"$B".title,"$B".descr,"$B".author_ID,"$B".genre_ID,"$B".stock,"$B".price,"$B".currency_code FROM sap_capire_bookshop_Books as "$B" WHERE "$B".title is not ?)',
        'db.statement': s => s.match(/SELECT/),
        'db.operation': 'READ',
        'db.sql.table': 'sap.capire.bookshop.Books',
        'db.client.response.returned_rows': 5
      }
    }
  ]
  // TODO
  // INSERT: []
  // UPDATE: []
  // DELETE: []
}
