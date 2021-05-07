/* eslint-env node */

"use strict";

var fluid = require("infusion");
var minimist = require("minimist");
var moment = require("moment");
var ExcelJS = require("exceljs");
var fs = require("fs");

fluid.require("%bagatelle");

require("./dataProcessing/readJSON.js");
require("./dataProcessing/readCSV.js");
require("./dataProcessing/readCSVwithMap.js");
require("./expressions/expr.js");

var hortis = fluid.registerNamespace("hortis");

fluid.setLogging(true);

var parsedArgs = minimist(process.argv.slice(2));

var pipeline = hortis.readJSONSync(parsedArgs.pipeline || "data/dataPaper-in/arpha-out.json5");

var summaryMap = hortis.readJSONSync(fluid.module.resolvePath(pipeline.summaryFileMap), "reading summary map file");

var summaryReader = hortis.csvReaderWithMap({
    inputFile: fluid.module.resolvePath(pipeline.summaryFile),
    mapColumns: summaryMap.columns
});

var obsMap = hortis.readJSONSync(fluid.module.resolvePath(pipeline.obsFileMap), "reading obs map file");

var obsReader = hortis.csvReaderWithMap({
    inputFile: fluid.module.resolvePath(pipeline.obsFile),
    mapColumns: obsMap.columns
});

var outputDir = fluid.module.resolvePath(pipeline.outputDir);
fs.mkdirSync(outputDir, { recursive: true });

hortis.genusEx = /\((.*)\)/;

hortis.normalise = function (str) {
    return str.replace(/\s+/g, " ").trim();
};

hortis.extractGenus = function (name, obj) {
    var matches = hortis.genusEx.exec(name);
    var togo;
    if (matches) {
        obj.Subgenus = matches[1];
        togo = name.replace(hortis.genusEx, "");
    } else {
        togo = name;
    }
    return hortis.normalise(togo);
};

hortis.extractSsp = function (name, obj) {
    var words = name.split(" ");

    if (words.length === 3) {
        var maybeSsp = words[2];
        if (maybeSsp.startsWith("complex")
            || maybeSsp.startsWith("agg")
            || maybeSsp.startsWith("s.lat.")
            || words[1].startsWith("cf")) {
            obj.Species = words[1] + " " + maybeSsp;
        } else {
            obj.Species = words[1];
            obj.Subspecies = maybeSsp;
        }
    } else if (words.length === 2) {
        obj.Species = words[1];
    } else {
        fluid.fail("Unexpected species name " + name);
    }
};

hortis.stringTemplateRegex = /\${([^\}]*)}/g;

hortis.stringTemplate = function (template, vars) {
    var replacer = function (all, match) {
        return vars[match] || "";
    };
    return template.replace(hortis.stringTemplateRegex, replacer);
};

hortis.mapTaxaRows = function (rows, columns) {
    return fluid.transform(rows, function (row) {
        var togo = {};
        fluid.each(columns, function (template, target) {
            togo[target] = hortis.stringTemplate(template, row);
        });
        if (row.species !== "" || row.genus !== "") {
            var degenified = hortis.extractGenus(row.taxonName, togo);
            hortis.extractSsp(degenified, togo);
        }
        return togo;
    });
};

// Also in coordinatePatch.js, leafletMap.js
hortis.datasetIdFromObs = function (obsId) {
    var colpos = obsId.indexOf(":");
    return obsId.substring(0, colpos);
};

hortis.mapMaterialsRows = function (rows, finalNameIndex, references, columns) {
    return fluid.transform(rows, function (row) {
        var togo = {};
        var dataset = hortis.datasetIdFromObs(row.observationId);
        row.scientificName = finalNameIndex[row.iNaturalistTaxonId];
        fluid.each(columns, function (template, target) {
            var outVal = "";
            if (template.startsWith("!references.")) {
                var ref = template.substring("!references.".length);
                outVal = fluid.getImmediate(references, [dataset, ref]) || "";
            } else if (template.startsWith("!Date:")) {
                var format = template.substring("!Date:".length);
                outVal = moment.utc(row.dateObserved).format(format);
            } else {
                outVal = hortis.stringTemplate(template, row);
            }
            if (outVal === "Confidence: ") { // blatant special casing
                outVal = "";
            }
            togo[target] = outVal;
        });
        
        if (row.coordinatesCorrected === "yes") {
            togo.georeferencedBy = "Andrew Simon";
            togo.georeferenceProtocol = "interpretation of locality, and/or inference based on local knowledge and species ecology";
            togo.georeferenceVerificationStatus = "corrected";
        }
        return togo;
    });
};

hortis.writeSheet = function (workbook, sheetName, rows) {
    var sheet = workbook.addWorksheet(sheetName);
    var keys = Object.keys(rows[0]);
    var header = sheet.getRow(1);
    keys.forEach(function (key, index) {
        header.getCell(index + 1).value = key;
    });
    rows.forEach(function (row, rowIndex) {
        var sheetRow = sheet.getRow(rowIndex + 2);
        keys.forEach(function (key, index) {
            sheetRow.getCell(index + 1).value = row[key];
        });
    });
};

hortis.writeExcel = function (sheets, key, outputDir) {
    if (sheets.Taxa.length === 0) {
        console.log("Skipping key " + key + " since no rows were selected");
        return fluid.promise().resolve();
    }
    var workbook = new ExcelJS.Workbook();

    hortis.writeSheet(workbook, "Taxa", sheets.Taxa);
    hortis.writeSheet(workbook, "Materials", sheets.Materials);

    var filename = outputDir + "/" + key + ".xlsx";
    var togo = workbook.xlsx.writeFile(filename);
    togo.then(function () {
        var stats = fs.statSync(filename);
        console.log("Written " + stats.size + " bytes to " + filename);
    });
    return togo;
};

hortis.indexFinalNames = function (summaryRows) {
    var togo = {};
    summaryRows.forEach(function (row) {
        togo[row.iNaturalistTaxonId] = row.taxonName;
    });
    return togo;
};

// TODO: Worry if obs and summaries diverge in taxonomy
hortis.filterArphaRows = function (rows, rec, rowCount) {
    return rows.filter(function (row, index) {
        var parsed = hortis.expr.parse(rec.filter);
        var match = hortis.expr.evaluate(parsed, row);
        if (match) {
            ++rowCount[index];
        }
        return match;
    });
};

hortis.verifyCounts = function (name, rowCount, rows) {
    rowCount.forEach(function (count, index) {
        if (count !== 1) {
            console.log("Anomalous " + name + " count for row " + index + ": " + count);
            console.log("Row contents: ", rows[index]);
        }
    });
};

var completion = fluid.promise.sequence([summaryReader.completionPromise, obsReader.completionPromise]);

completion.then(function () {
    var summaryRows = summaryReader.rows;
    console.log("Summary Input: " + summaryRows.length + " rows");
    var summaryRowCount = fluid.generate(summaryRows.length, 0);
    var obsRows = obsReader.rows;
    console.log("Obs Input: " + obsRows.length + " rows");
    var obsRowCount = fluid.generate(obsRows.length, 0);
    var finalNameIndex = hortis.indexFinalNames(summaryRows);
    var now = Date.now();
    var outs = fluid.transform(pipeline.files, function (rec, key) {
        var outSummaryRows = hortis.filterArphaRows(summaryRows, rec, summaryRowCount);
        console.log("Extracted " + outSummaryRows.length + " summary rows via filter " + key);

        var taxaRows = hortis.mapTaxaRows(outSummaryRows, pipeline.columns.Taxa);

        var outObsRows = hortis.filterArphaRows(obsRows, rec, obsRowCount);
        console.log("Extracted " + outObsRows.length + " obs rows via filter " + key);
        var materialsRows = hortis.mapMaterialsRows(outObsRows, finalNameIndex, pipeline.references, pipeline.columns.Materials);

        // console.log(remapped[0]);
        return {
            Taxa: taxaRows,
            Materials: materialsRows
        };
    });
    console.log("Total extracted obs rows: " + fluid.flatten(fluid.getMembers(outs, "Materials")).length);
    console.log("Filtered obs in " + (Date.now() - now) + " ms");
    hortis.verifyCounts("summary", summaryRowCount, summaryRows);
    hortis.verifyCounts("obs", obsRowCount, obsRows);

    fluid.each(outs, function (sheets, key) {
        hortis.writeExcel(sheets, key, outputDir);
    });
}, function (err) {
    console.log("Error ", err);
});
