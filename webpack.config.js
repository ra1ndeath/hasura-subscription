const path = require('path');
module.exports = {
    mode: 'production',
    entry: './src/index.js',
    target: 'node',
    output: {
        path: path.resolve(__dirname, './dist'),
        filename: 'index.js',
        library: 'integrationChat',
        libraryTarget: 'umd',
        globalObject: 'this',
    },
    module: {
        rules: [{
            test: /\.js$/,
            exclude: /(node_modules)/,
            use: 'babel-loader',
        }],
    },
};