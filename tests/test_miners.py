"""
Unit tests for miner API handlers
"""
import unittest
from unittest.mock import Mock, patch, MagicMock
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from miners.bitaxe import BitaxeAPIHandler
from miners.cgminer import CGMinerAPIHandler
from miners.detector import MinerDetector, Miner
from tests.mock_responses import *


class TestBitaxeAPIHandler(unittest.TestCase):
    """Test Bitaxe API handler"""

    def setUp(self):
        self.handler = BitaxeAPIHandler()

    @patch('requests.get')
    def test_detect_bitaxe(self, mock_get):
        """Test Bitaxe detection"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = BITAXE_SYSTEM_INFO
        mock_get.return_value = mock_response

        result = self.handler.detect('10.0.0.100')
        self.assertTrue(result)

    @patch('requests.get')
    def test_detect_not_bitaxe(self, mock_get):
        """Test detection failure"""
        mock_get.side_effect = Exception("Connection refused")

        result = self.handler.detect('10.0.0.100')
        self.assertFalse(result)

    @patch('requests.get')
    def test_get_status_online(self, mock_get):
        """Test getting status from online Bitaxe"""
        mock_response = Mock()
        mock_response.json.return_value = BITAXE_SYSTEM_INFO
        mock_get.return_value = mock_response

        status = self.handler.get_status('10.0.0.100')

        self.assertEqual(status['status'], 'online')
        self.assertEqual(status['hashrate'], 1100000000000)
        self.assertEqual(status['temperature'], 65.2)
        self.assertEqual(status['power'], 90.5)
        self.assertEqual(status['fan_speed'], 80)
        self.assertEqual(status['model'], 'BM1397')

    @patch('requests.get')
    def test_get_status_timeout(self, mock_get):
        """Test timeout handling"""
        import requests
        mock_get.side_effect = requests.exceptions.Timeout()

        status = self.handler.get_status('10.0.0.100')

        self.assertEqual(status['status'], 'offline')
        self.assertIn('error', status)


class TestCGMinerAPIHandler(unittest.TestCase):
    """Test CGMiner API handler"""

    def setUp(self):
        self.handler = CGMinerAPIHandler()

    @patch('socket.socket')
    def test_detect_cgminer(self, mock_socket):
        """Test CGMiner detection"""
        mock_sock = MagicMock()
        mock_sock.recv.return_value = json.dumps(CGMINER_VERSION).encode()
        mock_socket.return_value = mock_sock

        result = self.handler.detect('10.0.0.101')
        self.assertTrue(result)

    @patch('socket.socket')
    def test_get_status_antminer(self, mock_socket):
        """Test getting status from Antminer"""
        import json

        def recv_side_effect(size):
            # Return different responses based on command
            return json.dumps(CGMINER_SUMMARY).encode()

        mock_sock = MagicMock()
        mock_sock.recv.side_effect = [
            json.dumps(CGMINER_SUMMARY).encode(),
            b'',  # End of summary response
        ]
        mock_socket.return_value = mock_sock

        # Mock multiple commands
        with patch.object(self.handler, '_send_command') as mock_send:
            mock_send.side_effect = [
                CGMINER_SUMMARY,
                CGMINER_DEVS,
                CGMINER_VERSION
            ]

            status = self.handler.get_status('10.0.0.101')

            self.assertEqual(status['status'], 'online')
            self.assertEqual(status['hashrate'], 13500000 * 1000000)
            self.assertEqual(status['temperature'], 65.0)
            self.assertEqual(status['model'], 'Antminer')


class TestMinerDetector(unittest.TestCase):
    """Test miner detector"""

    def setUp(self):
        self.detector = MinerDetector()

    @patch('miners.bitaxe.BitaxeAPIHandler.detect')
    @patch('miners.bitaxe.BitaxeAPIHandler.get_status')
    def test_detect_bitaxe_miner(self, mock_status, mock_detect):
        """Test detecting Bitaxe miner"""
        mock_detect.return_value = True
        mock_status.return_value = {
            'status': 'online',
            'model': 'BM1397',
            'hashrate': 1100000000000,
            'temperature': 65.2
        }

        miner = self.detector.detect('10.0.0.100')

        self.assertIsNotNone(miner)
        self.assertEqual(miner.ip, '10.0.0.100')
        self.assertEqual(miner.type, 'Bitaxe')

    @patch('miners.bitaxe.BitaxeAPIHandler.detect')
    @patch('miners.cgminer.CGMinerAPIHandler.detect')
    def test_detect_no_miner(self, mock_cgminer, mock_bitaxe):
        """Test no miner found"""
        mock_bitaxe.return_value = False
        mock_cgminer.return_value = False

        miner = self.detector.detect('10.0.0.100')

        self.assertIsNone(miner)


if __name__ == '__main__':
    unittest.main()
