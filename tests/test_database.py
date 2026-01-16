"""
Unit tests for database operations
"""
import unittest
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import Database


class TestDatabase(unittest.TestCase):
    """Test database operations"""

    def setUp(self):
        """Create temporary database for testing"""
        self.db_fd, self.db_path = tempfile.mkstemp()
        self.db = Database(self.db_path)

    def tearDown(self):
        """Clean up temporary database"""
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_add_miner(self):
        """Test adding a miner"""
        miner_id = self.db.add_miner('10.0.0.100', 'Bitaxe', 'BM1397')
        self.assertIsNotNone(miner_id)
        self.assertGreater(miner_id, 0)

    def test_update_miner(self):
        """Test updating a miner"""
        self.db.update_miner('10.0.0.100', 'Bitaxe', 'BM1397')
        miner = self.db.get_miner_by_ip('10.0.0.100')

        self.assertIsNotNone(miner)
        self.assertEqual(miner['ip'], '10.0.0.100')
        self.assertEqual(miner['miner_type'], 'Bitaxe')
        self.assertEqual(miner['model'], 'BM1397')

    def test_get_all_miners(self):
        """Test getting all miners"""
        self.db.update_miner('10.0.0.100', 'Bitaxe', 'BM1397')
        self.db.update_miner('10.0.0.101', 'Antminer', 'S9')

        miners = self.db.get_all_miners()
        self.assertEqual(len(miners), 2)

    def test_add_stats(self):
        """Test adding statistics"""
        miner_id = self.db.add_miner('10.0.0.100', 'Bitaxe', 'BM1397')
        self.db.add_stats(
            miner_id,
            hashrate=1100000000000,
            temperature=65.2,
            power=90.5,
            fan_speed=80
        )

        stats = self.db.get_latest_stats(miner_id)
        self.assertIsNotNone(stats)
        self.assertEqual(stats['hashrate'], 1100000000000)
        self.assertEqual(stats['temperature'], 65.2)

    def test_delete_miner(self):
        """Test deleting a miner"""
        self.db.update_miner('10.0.0.100', 'Bitaxe', 'BM1397')
        self.db.delete_miner('10.0.0.100')

        miner = self.db.get_miner_by_ip('10.0.0.100')
        self.assertIsNone(miner)


if __name__ == '__main__':
    unittest.main()
