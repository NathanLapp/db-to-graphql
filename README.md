# db-to-graphql

A graphql schema generator that uses the schema(s) of a database to generate a graphql schema.

### Currently supported databases

  * Oracle

### Current implementation of the graphql spec
  * Oracle
    * Read only
    * AND filtering

## Getting Started
A database and database user must already be created. What tables and database schema(s) are made available to graphQL depends on the select permissions of the used database user. For further refinement, one or more database schemas can be specified as an optional parameter.

### Using db-to-graphql

Install db-to-graphql

using npm:

```sh
npm install --save db-to-graphql
```

Using this package:

```js
var dbToGraphql = require('db-to-graphql');

const DB_CONNECTION = {
  user: 'user',
  password: 'pass',
  connectionString: 'hostname:port/sid'
};

dbToGraphql.generateGraphQL(DB_CONNECTION, 'Oracle')
.then(function(generatedGraphql) {
  let {root, schema} = generatedGraphql;
})
.catch((err) => {
  console.log(err);
});
```

If you want to restrict which schemas are used for graphql and don't want to modify the permissions for the database user:
```js
dbToGraphql.generateGraphQL(DB_CONNECTION, 'Oracle', ['SCHEMA1', 'SCHEMA2'])
```

### Dependencies
  * [Oracle thin client](https://oracle.github.io/odpi/doc/installation.html)
    * Required for the [oracledb](https://github.com/oracle/node-oracledb/blob/master/INSTALL.md) package.
  * graphql
  * lodash

### Contributing

I encourage contribution especially with supporting more databases.

### Changelog

Changes are tracked as [GitHub releases](https://github.com/NathanLapp/db-to-graphql/releases).

### License

db-to-graphql is [MIT-licensed](https://github.com/NathanLapp/db-to-graphql/blob/master/LICENSE).