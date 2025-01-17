'use strict';
const aws = require('aws-sdk');
const crypto = require('crypto');
const dynamodb = new aws.DynamoDB();
const https = require('https');

const pricing_host = 'https://pricing.us-east-1.amazonaws.com';
const current_region_index_path = '/offers/v1.0/aws/AmazonS3/current/region_index.json';

// we use the md5 hash to generate a unique key for the items we insert
const md5sum = crypto.createHash('md5');

// hardcode the sku (Stock Keeping Unit) for each of the storage types
const storage_type_sku = {
    'Reduced Redundancy': '2M7QTWC3ZQPKXMXZ',
    'Standard': '4AJHPB29ZPVFADXP',
    'Glacier': 'SX7QQVPF4M2A4YZ2',
    'Infrequent Access': '62UY3D5HXV9CXNMK'
};

exports.handler = (event, context, callback) => {

    if(event['offerCode'] != 'AmazonS3') {
        callback(null, 'We are only interested in AmazonS3 price updates');
    }

    https.get(pricing_host + current_region_index_path, (response) => {

        let raw_data = '';
        response.on('data', (chunk) => {
            raw_data += chunk;
        });

        response.on('end', () => {
            let region_index = JSON.parse(raw_data);
            let s3_current_version_path = region_index['regions']['eu-west-1']['currentVersionUrl'];

            https.get(pricing_host + s3_current_version_path, (response) => {

                var raw_data = '';
                response.on('data', (chunk) => {
                    raw_data += chunk;
                });

                response.on('end', () => {
                    let s3_prices = JSON.parse(raw_data);

                    Object.keys(storage_type_sku).forEach((storage_type) => {
                        let sku = storage_type_sku[storage_type];
                        storage_type_prices = s3_prices['terms']['OnDemand'][sku];

                        // get the first (and only) object that contains the prices
                        let effective_date = storage_type_prices[Object.keys(storage_type_prices)[0]]['effectiveDate'];
                        let pricing = storage_type_prices[Object.keys(storage_type_prices)[0]]['priceDimensions'];

                        bulkUpdateDynamoDb(storage_type, effective_date, pricing);
                    });

                    callback(null, 'All storage types updated');
                });
            });
        });
    });
};

bulkUpdateDynamoDb = (storage_type, effective_date, pricing) => {
    let params = {
        'RequestItems': {
            's3_storage_prices': []
        }
    };

    for (const key of Object.keys(pricing)) {
        let date = Date.parse(effective_date).toString();
        let price = pricing[key]['pricePerUnit']['USD'];
        let beginRange = pricing[key]['beginRange'];
        let endRange = pricing[key]['endRange'];

        let id = crypto.createHash('md5').update(date + storage_type + beginRange + endRange).digest('hex');

        let item = {
            'PutRequest': {
                Item: {
                    'id': {
                        'S': id
                    },
                    'StorageType': {
                        'S': storage_type
                    },
                    'Date': {
                        'S': date
                    },
                    'Price': {
                        'S': price
                    },
                    'BeginRange': {
                        'S': beginRange
                    },
                    'EndRange': {
                        'S': endRange
                    }
                }
            }
        };

        params['RequestItems']['s3_storage_prices'].push(item);
    }

    dynamodb.batchWriteItem(params);
};