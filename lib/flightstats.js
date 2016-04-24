'use strict';

const config = require('../config.json') || {};
const google = require('googleapis');
const Q = require('q');
const base64 = require('base-64');
const utf8 = require('utf8');
const mimelib = require('mimelib');
const moment = require('moment');
const json2csv = require('json2csv');
const inquirer = require('inquirer');
const mkdirp = require('mkdirp');
const path = require('path');
const Spinner = require('cli-spinner').Spinner;
const open = require('open');
const fs = require('fs');
const _ = require('lodash');
const chalk = require('chalk');
const FLIGHTNUMBERS = /\s(([a-z][a-z]|[a-z][0-9]|[0-9][a-z])[a-z]?)([0-9]{1,4}[a-z]?)/gi;
const DATES = /([0-3]?[0-9])(\s|-)?(Jan|Feb|Mar|Apr|Mai|Jun|Jul|Aug|Sep|O(c|k)t|Nov|De(c|z))(\s|-)?((19|20)?[0-9]{2})/gi;
let $;

const infoColor = chalk.cyan.bold;
const successColor = chalk.green.bold;
const bold = chalk.bold;

let request = require('request');
let cookieJar = request.jar();
let cookie = request.cookie('w_locale=en_US');
cookieJar.setCookie(cookie, 'https://flightaware.com/');
request = request.defaults({jar: cookieJar});

function debug() {
  if (process.env.NODE_ENV && process.env.NODE_ENV.toLowerCase()==='debug')
    Function.apply.call(console.log, console, arguments);
}

require("jsdom").env("", function(err, window) {
  if (err) {
    console.error(err);
    return;
  }

  $ = require("jquery")(window);
});

class FlightStats {
  constructor(overrideDefaults) {
    this.config = _.defaultsDeep(overrideDefaults || {}, config);
    this.allFlightConnections = [];
  }

  createFlightMapping(bookings) {
    this.allFlights = {};
    bookings.forEach(booking => {
      if (Array.isArray(booking)) {
        booking.forEach(flight => {
          this.allFlights[flight] = this.allFlights[flight] || 0;
          this.allFlights[flight]++;
        });
      }
    });
    return this.allFlights;
  }

  getFlightInfo(flightCode) {
    let url = `https://flightaware.com/live/flight/${flightCode}?locale=en_US`;
    let deferred = Q.defer();
    request.get(url, (err, response, body) => {
      if (err || response.statusCode !== 200) {
        console.log(err);
        deferred.reject('Invalid!');
        return;
      }

      let $dom = $(body);

      let info = {};
      info.code = flightCode;
      info.duration = $dom.find('.track-panel-duration').text().match(/\d+/g);
      info.from = $dom.find('.track-panel-departure').text().trim().replace(/\s+/g, ' ');
      info.to = $dom.find('.track-panel-arrival').text().trim().replace(/\s+/g, ' ');
      info.distance = $dom.find('.secondaryHeader:contains("Distance")').parent().find('.smallrow2').text().match(/\d*,?\d+/g);

      if (_.isNull(info.duration)) {
        delete this.allFlights[flightCode];

        debug(`Invalid flight code: ${flightCode}`);

        deferred.resolve();
        return;
      }

      if (Array.isArray(info.distance)) {
        info.distance = info.distance.length > 1 ? parseInt(info.distance[1].replace(/,/g, ''), 10) : parseInt(info.distance[0].replace(/,/g, ''), 10);
      }

      if (Array.isArray(info.duration) && info.duration.length === 2) {
        info.duration = moment.duration({hours: parseInt(info.duration[0], 10), minutes: parseInt(info.duration[1], 10)})
      } else if (Array.isArray(info.duration) && info.duration.length === 1) {
        info.duration = moment.duration({minutes: parseInt(info.duration[0], 10)})
      } else {
        info.duration = moment.duration({minutes: 0});
      }

      deferred.resolve(info);
    });

    return deferred.promise;
  }

  findEmails() {
    let spinner = new Spinner('Searching for flight emails... %s');
    let query = _.map(this.config.flightEmails, email => `from:${email}`).join(' OR ');
    let deferred = Q.defer();
    spinner.start();
    this.gmail = google.gmail('v1');
    this.gmail.users.messages.list({
      auth: this.auth,
      userId: 'me',
      q: query,
      maxResults: 300
    }, (err, response) => {
      spinner.stop(true);
      console.log('Searching for flight emails... %s', chalk.green('DONE'));
      if (err) {
        console.error(err);
        deferred.reject(err);
        return;
      }

      deferred.resolve(response.messages);
    });
    return deferred.promise;
  }

  getFlightCodesFromEmail(id) {
    let deferred = Q.defer();

    this.gmail.users.messages.get({
      auth: this.auth,
      userId: 'me',
      id: id,
      fields: 'payload'
    }, (err, response) => {
      if (err) {
        console.error(err);
        deferred.reject(err);
        return;
      }
      let filtered = _.filter(response.payload.parts, part => part.mimeType === 'text/html');
      if (filtered.length > 0) {
        let decoded;
        try {
          let body = $(mimelib.decodeBase64(filtered[0].body.data)).text();
          let dateMatches = body.match(DATES);
          let matches = _.chain(body.match(FLIGHTNUMBERS));
          decoded = matches.map(m => m.trim()).uniq().value();
          this.allFlightConnections.push({
            dates: _.chain(dateMatches).map(d => d.replace(/\s/gi, '')).uniq().value(),
            codes: decoded
          })
        } catch (e) {
          decoded = 'FAILED!!!';
        }
        deferred.resolve(decoded);
      } else {
        deferred.resolve();
      }
    });

    return deferred.promise;
  }

  getFlightCounts(emails) {
    let spinner = new Spinner('Retrieving flight codes... %s');
    spinner.start();
    return Q.all(_.map(emails, msg => this.getFlightCodesFromEmail(msg.id)))
      .then(bookings => {
        spinner.stop(true);
        console.log('Retrieving flight codes... %s', chalk.green('DONE'));
        return this.createFlightMapping(bookings);
    });
  }

  getFlightDetails(flightCounts) {
    let spinner = new Spinner('Retrieving flight info... %s');
    spinner.start();
    return Q.all(_.map(Object.keys(flightCounts), flightCode => this.getFlightInfo(flightCode))).then(infos => {
      this.infoDictionary = {};
      infos.forEach(info => {
        if (info && info.code) {
          this.infoDictionary[info.code] = info;
        }
      });

      spinner.stop(true);
      console.log('Retrieving flight info... %s', chalk.green('DONE'));
      return this.infoDictionary;
    });
  }

  cleanUpFlightData() {
    let connections = _.chain(this.allFlightConnections);

    debug('flightdata\n', connections.value());
    connections = connections.filter(conn => _.isArray(conn.codes) && conn.codes.length !== 0).map(conn => {
      conn.codes = _.filter(conn.codes, code => this.allFlights[code]);
      return conn;
    });

    return connections.value();
  }

  createFlightList(bookings) {
    debug('bookings\n', bookings);
    let flights = [];
    bookings.forEach(booking => {
      booking.dates.forEach((date, idx) => {
        let code = booking.codes[idx];
        if (code) {
          flights.push({
            date: date,
            code: code,
            duration: this.infoDictionary[code].duration.asMinutes(),
            distance: this.infoDictionary[code].distance,
            from: this.infoDictionary[code].from,
            to: this.infoDictionary[code].to
          });
        }
      });
    });

    return _.uniqWith(flights, _.isEqual);
  }

  writeToCsv(flightList) {
    let deferred = Q.defer();
    let folderName = path.join(__dirname, '../out/');
    let fileName = path.join(folderName, 'flightdata.csv');
    mkdirp.sync(folderName);
    json2csv({
      data: flightList,
      fields: ['date', 'code', 'from', 'to', 'distance', 'duration'],
      fieldNamess: ['Date', 'Flight Code', 'From', 'To', 'Distance', 'Duration']
    }, (err, csv) => {
      if (err) {
        console.error(err);
        return deferred.reject(err);
      }
      fs.writeFile(fileName, csv, function (err) {
        if (err) {
          console.error(err);
          return deferred.reject(err);
        }
        console.log(`${bold('File saved!')} ${fileName}`);
        return deferred.resolve(fileName);
      })
    });
    return deferred.promise;
  }

  makeStats() {
    console.log('Gathering stats...');
    this.stats = {
      totalFlightSum: 0
    }

    let totalDistance = 0;
    let totalFlights = 0;
    let totalTime = 0;

    let flightList = this.createFlightList(this.cleanUpFlightData());

    flightList.forEach(flight => {
      if (!_.isNull(flight.distance)) {
        totalDistance += flight.distance;
        totalTime += flight.duration;
      }
    });

    totalFlights = flightList.length;

    console.log(`${bold('Results:')}
    ${successColor('Total Flights')}: ${totalFlights}
    ${successColor('Total Time')}: ${totalTime} minutes
    ${successColor('Total Distance')}: ${totalDistance} miles
    `);

    return flightList;
  }

  promptToOpen(fileName) {
    return inquirer.prompt([
      {message: 'Do you want to open the CSV?', name: 'open', default: false, type: 'confirm'}
    ]).then(answers => {
      if (answers.open) {
        open(fileName);
      }
      return answers.open;
    });
  }

  getStats(auth) {
    this.auth = auth;
    return this.findEmails()
      .then(emails => this.getFlightCounts(emails))
      .then(flightCounts => this.getFlightDetails(flightCounts))
      .then(details => this.makeStats())
      .then(flightList => this.writeToCsv(flightList))
      .then(fileName => this.promptToOpen(fileName));
  }

}

module.exports = FlightStats;