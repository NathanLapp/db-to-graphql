var oracledb = require('oracledb');
var _ = require("lodash");
const vm = require('vm');
var { graphql, buildSchema } = require('graphql');

oracledb.queueTimeout = 0;
oracledb.poolTimeout = 0;

var maxRows = 200;

var setMaxRows = function(val) {
  maxRows = val;
};

/*
IN:
__dbConnection = { user: "", password: "", connectionString: "host:port/sid" }
dbType = "" // "Oracle"
selectedSchemas = ['', '', '', ...]
OUT:
{
  root: {},
  schema: buildSchema('')
}
*/
var generateGraphQL = function(__dbConnection, dbType, selectedSchemas = null) {
  return new Promise(function (resolve, reject) {
    if (dbType === 'Oracle') {
      getOracleORM(__dbConnection)
      .then(function(dbSchema) {
        var root = {};
        const sandbox = { root: root, dbSchema: dbSchema };
        var code;
        vm.createContext(sandbox);

        var graphqlSchema = '';
        var schemaQuery = 'type Query {';
        var selectedTables;
        
        if (selectedSchemas != null) {
          selectedTables = _.filter(dbSchema, function(o) {
            return _.includes(selectedSchemas, o.name);
          });
        }
        else {
          selectedTables = dbSchema;
        }


        // graphqlSchema
        _.forEach(selectedTables, function(tables) {
          _.forEach(tables.Tables, function(table) {
            schemaQuery += `
          ${table.owner}_${table.name}(`;
            graphqlSchema += `
        type ${table.owner}_${table.name} {`;
            var isFirst = true;
            Object.keys(table).forEach(function (key) {
              if (key != 'DB_CONNECTION' && key != 'DB_TYPE' && key != 'selectColumns' && typeof table[key] == 'object') {
                graphqlSchema += `
          ${table[key].name}: ${translateJStoGraphQLType(table[key].dataType)}`;
                if (!isFirst) schemaQuery += ', ';
                schemaQuery += table[key].name + ': ' + translateJStoGraphQLType(table[key].dataType) + ' = null';
                isFirst = false;
              }
            });
            graphqlSchema += `
        }`;
            schemaQuery += '): [' + table.owner + '_' + table.name + ']';
          });
        });
        schemaQuery += `
        }`;
        graphqlSchema += `
        ${schemaQuery}`;

        // root
        var rootFunction = '';
        _.forEach(selectedTables, function(tables) {
          _.forEach(tables.Tables, function(table) {
            rootFunction = 'root.' + table.owner + '_' + table.name + ' = function({' + table.selectColumnsFormatted.join() + '}) { let whereColumns = [];';
            _.forEach(table.selectColumnsFormatted, function(column) {
              rootFunction += ' if (' + column + ' != null) { whereColumns.push({';
              rootFunction += ' column: dbSchema.' + table.owner + '.Tables.' + table.name + '.' + column + ',';
              rootFunction += ' value: ' + column + ',';
              rootFunction += ' operation: \'AND\' }); }';
            });
            rootFunction += ' if (whereColumns.length > 0) {';
            rootFunction += ' return dbSchema.' + table.owner + '.Tables.' + table.name + '.findAll(whereColumns).then(function(res) { return res; }).catch((err) => { console.log(err); }); }';
            rootFunction += ' else {';
            rootFunction += ' return dbSchema.' + table.owner + '.Tables.' + table.name + '.findAll().then(function(res) { return res; }).catch((err) => { console.log(err); }); } };';

            vm.runInContext(rootFunction, sandbox);
          });
        });
        resolve({ root: root, schema: buildSchema(graphqlSchema) });
      })
      .catch((err) => {
        console.log(err);
      });
    }
  });
};

var findAll = function(whereColumns = null) {
  var data = getData(this.DB_CONNECTION, this.DB_TYPE, { name: this.name, owner: this.owner }, this.selectColumns, whereColumns)
  .then(function(queryData) {
    return queryData;
  })
  .catch((err) => {
    console.log(err);
  });

  return new Promise(function (resolve, reject) {
    data
    .then(function(val) {
      resolve(val);
    });
  });
};

var verifyDatabaseConnection = function(__dbConnection) {
  if (__dbConnection == null || __dbConnection.user == null || __dbConnection.password == null || __dbConnection.connectionString == null) return false;
  else return true;
};

var translateJStoGraphQLType = function(type) {
  switch(type) {
    case 'STRING':
      return 'String';
    case 'NUMBER':
      return 'Int';
    default:
      return 'String';
  }
};

var getData = function(__dbConnection, __dbType, fromTable, selectColumns, whereColumns = null) {return new Promise(function (resolve, reject) {
  if (!verifyDatabaseConnection(__dbConnection)) reject();
  if (fromTable == null || fromTable.name == null || fromTable.owner == null || selectColumns == null || selectColumns.length === 0) reject();
  if (whereColumns != null && whereColumns.length === 0) reject();

  switch(__dbType) {
    case "ORACLE":
      oracledb.getConnection({
        user: __dbConnection.user,
        password: __dbConnection.password,
        connectString: __dbConnection.connectionString
      },
      function(err, connection) {
        if (err) {
          console.log(err);
          connection.close();
          reject();
        }

        var bindvars = {
          cursor: { type: oracledb.CURSOR, dir: oracledb.BIND_OUT }
        };

        var query = 'BEGIN OPEN :cursor FOR SELECT ';
        for (let i = 0; i < selectColumns.length; i++) {
          query += '' + selectColumns[i];
          if (selectColumns[i+1] != null) query += ',';
        }

        query += ' FROM ' + fromTable.owner + '.' + fromTable.name;

        const sandbox = { bindvars: bindvars, whereColumns: whereColumns };
        var code = '';
        vm.createContext(sandbox);
        if (whereColumns != null) {
          for (let i = 0; i < whereColumns.length; i++) {
            if (i === 0) query += ' WHERE (ROWNUM <= ' + maxRows + ') AND (';
            else query += ' ' + whereColumns[i].operation;

            query += ' ' + whereColumns[i].column.name + ' = :' + whereColumns[i].column.name+i;
            code = 'bindvars.' + whereColumns[i].column.name+i + ' = whereColumns[' + i + '].value;';
            vm.runInContext(code, sandbox);
          }
          query += ')';
        }
        else {
          query += ' WHERE (ROWNUM <= ' + maxRows + ')';
        }
        bindvars = sandbox.bindvars;
        query += "; END;";

        connection.execute(query, bindvars, {prefetchRows: 400}, function(err, result) {
          var cursor;
          var stream;
          var sandbox2 = { resRow: {}, dbData: [] };
          vm.createContext(sandbox2);
          var code2 = '';

          if (err) {
            console.log(err);
            connection.close();
            reject();
          }

          cursor = result.outBinds.cursor;
          stream = cursor.toQueryStream();

          stream.on('data', function (row) {
            sandbox2.row = row;
            code2 = 'resRow = {};';
            vm.runInContext(code2, sandbox2);
            code2 = '';
            for (let i = 0; i < selectColumns.length; i++) {
              let splitColumnName = selectColumns[i].split(' ');
              if (row[i] == null) code2 += ' resRow.' + splitColumnName[splitColumnName.length-1] + ' = null;';
              else if (typeof row[i] == "number") code2 += ' resRow.' + splitColumnName[splitColumnName.length-1] + ' = row[' + i + '];';
              else code2 += ' resRow.' + splitColumnName[splitColumnName.length-1] + ' = row[' + i + '];';
            }
            code2 += 'dbData.push(resRow);';
            vm.runInContext(code2, sandbox2);
          });

          stream.on('end', function () {
            connection.close();
            resolve(sandbox2.dbData);
          });
        });
      }
      );
      break;
    default:
      reject();
  }
});
};

/*
Schemas.DB_CONNECTION;
Schemas.DB_TYPE;
Schemas.SCHEMA_NAME.name;
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.name;
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.owner;
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.DB_CONNECTION;
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.DB_TYPE;
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.selectColumns;
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.findAll({ column: "COLUMN_NAME", value: "VALUE", operation: "AND" });
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.COLUMN_NAME.name;
Schemas.SCHEMA_NAME.Tables.TABLE_NAME.COLUMN_NAME.dataType;
*/
var getOracleORM = function(__dbConnection) { return new Promise(function (resolve, reject) {
  if (!verifyDatabaseConnection(__dbConnection)) reject();
  
  oracledb.getConnection(
  {
    user: __dbConnection.user,
    password: __dbConnection.password,
    connectString: __dbConnection.connectionString
  },
  function(err, connection) {
    if (err) {
      console.log(err);
      connection.close();
      reject();
    }

    var bindvars = {
      cursor: { type: oracledb.CURSOR, dir: oracledb.BIND_OUT }
    };

    var query = `BEGIN OPEN :cursor FOR

    SELECT '{'
      || '"tableName": "' || tab.TABLE_NAME || '",'
      || '"owner": "' || tab.OWNER || '",'
      || '"columnName": "' || tab.COLUMN_NAME || '",'
      || '"dataType": "' ||  CASE WHEN tab.DATA_TYPE LIKE 'VARCHAR%' THEN 'STRING'
        WHEN tab.DATA_TYPE = 'CHAR' THEN 'STRING'
        WHEN tab.DATA_TYPE = 'DATE' THEN 'STRING'
        WHEN tab.DATA_TYPE LIKE 'TIMESTAMP%' THEN 'STRING'
        WHEN tab.DATA_TYPE LIKE 'LONG%' THEN 'NUMBER'
        WHEN tab.DATA_TYPE = 'RAW' THEN 'STRING'
        WHEN tab.DATA_TYPE LIKE '_LOB' THEN 'STRING'
        WHEN tab.DATA_TYPE = 'RAW' THEN 'STRING'
        ELSE 'STRING' END || '"'
      || '}' AS JSON
    FROM ALL_TAB_COLUMNS tab
    WHERE tab.OWNER NOT IN ('SYS', 'SYSTEM')
      AND tab.TABLE_NAME NOT IN ('PLSQL_PROFILER_DATA', 'TOAD_PLAN_TABLE')
      AND REGEXP_INSTR(tab.COLUMN_NAME ,'[^[:alnum:]_*]') = 0
      AND REGEXP_INSTR(tab.TABLE_NAME ,'[^[:alnum:]_*]') = 0
    UNION ALL
    SELECT '{'
      || '"tableName": "' || syn.SYNONYM_NAME || '",'
      || '"owner": "' || tab.OWNER || '",'
      || '"columnName": "' || tab.COLUMN_NAME || '",'
      || '"dataType": "' ||  CASE WHEN tab.DATA_TYPE LIKE 'VARCHAR%' THEN 'STRING'
        WHEN tab.DATA_TYPE = 'CHAR' THEN 'STRING'
        WHEN tab.DATA_TYPE = 'DATE' THEN 'STRING'
        WHEN tab.DATA_TYPE LIKE 'TIMESTAMP%' THEN 'STRING'
        WHEN tab.DATA_TYPE LIKE 'LONG%' THEN 'NUMBER'
        WHEN tab.DATA_TYPE = 'RAW' THEN 'STRING'
        WHEN tab.DATA_TYPE LIKE '_LOB' THEN 'STRING'
        WHEN tab.DATA_TYPE = 'RAW' THEN 'STRING'
        ELSE 'STRING' END || '"'
      || '}' AS JSON
    FROM ALL_SYNONYMS syn
    JOIN ALL_TAB_COLUMNS tab ON syn.TABLE_NAME = tab.TABLE_NAME
    WHERE syn.SYNONYM_NAME != syn.TABLE_NAME
      AND syn.OWNER NOT IN ('SYS', 'SYSTEM', 'PUBLIC')
      AND syn.TABLE_OWNER NOT IN ('SYS', 'SYSTEM', 'PUBLIC')
      AND NOT EXISTS (
        SELECT 1 FROM ALL_TAB_COLUMNS x
        WHERE x.TABLE_NAME = syn.SYNONYM_NAME
          AND x.OWNER NOT IN ('SYS', 'SYSTEM')
          AND x.TABLE_NAME NOT IN ('PLSQL_PROFILER_DATA', 'TOAD_PLAN_TABLE')
          AND REGEXP_INSTR(x.COLUMN_NAME ,'[^[:alnum:]_*]') = 0
          AND REGEXP_INSTR(x.TABLE_NAME ,'[^[:alnum:]_*]') = 0
      );

    END;`;

    connection.execute(query, bindvars, {prefetchRows: 400}, function(err, result) {
      var cursor;
      var stream;
      var __orm = [];

      if (err) {
        console.log(err);
        connection.close();
        reject();
      }

      cursor = result.outBinds.cursor;
      stream = cursor.toQueryStream();

      stream.on('data', function (row) {
        __orm.push(JSON.parse(row[0]));
      });

      stream.on('end', function (row) {
        connection.close();
        var orm = [];
        
        _.forEach(__orm, function(value, key) {
          var ind = _.findIndex(orm, { ownerValue: value.owner, tableNameValue: value.tableName } );
          
          if (ind === -1) {
            var code1 = {
              owner: value.owner.replace(/\W/g, ''),
              ownerValue: value.owner,
              tableName: value.tableName.replace(/\W/g, ''),
              tableNameValue: value.tableName,
              columns: [{ 
                columnName: value.columnName.replace(/\W/g, ''),
                columnNameValue: value.columnName,
                dataType: value.dataType
              }]
            };
            orm.push(code1);
          }
          else {
            var code2 = orm[ind];
            code2.columns.push({ 
              columnName: value.columnName.replace(/\W/g, ''),
              columnNameValue: value.columnName,
              dataType: value.dataType
            });
            orm[ind] = code2;
          }
        });

        var Schemas = {};
        const sandbox = { orm: orm, Schemas: Schemas, findAll: findAll, __dbConnection: __dbConnection };
        var code = '';
        vm.createContext(sandbox);

        code = 'Schemas.DB_CONNECTION = __dbConnection;';
        code += 'Schemas.DB_TYPE = \'ORACLE\';';
        vm.runInContext(code, sandbox);

        for (let i = 0; i < orm.length; i++) {
          code = 'if (Schemas.' + orm[i].owner +' == null) { Schemas.' + orm[i].owner + ' = {}; Schemas.' + orm[i].owner + '.Tables = {};Schemas.' + orm[i].owner + '.name = \"' + orm[i].owner + '\";}';

          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + ' = {};';
          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.name = "' + orm[i].tableNameValue + '";';
          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.owner = "' + orm[i].ownerValue + '";';
          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.findAll = findAll;';
          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.selectColumns = [];';
          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.selectColumnsFormatted = [];';
          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.DB_CONNECTION = __dbConnection;';
          code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.DB_TYPE = \'ORACLE\';';

          for (let j = 0; j < orm[i].columns.length; j++) {
            code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.' + orm[i].columns[j].columnName + ' = {};';
            code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.' + orm[i].columns[j].columnName + '.name = "' + orm[i].columns[j].columnNameValue + '";';
            code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.' + orm[i].columns[j].columnName + '.dataType = "' + orm[i].columns[j].dataType + '";';
            code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.selectColumns.push("' + orm[i].columns[j].columnNameValue + '");';
            code += 'Schemas.' + orm[i].owner + '.Tables.' + orm[i].tableName + '.selectColumnsFormatted.push("' + orm[i].columns[j].columnName + '");';
          }
          vm.runInContext(code, sandbox);
        }

        resolve(sandbox.Schemas);
      });
    });
  }
  );
});
};

module.exports = {
  generateGraphQL: generateGraphQL,
  setMaxRows: setMaxRows
};